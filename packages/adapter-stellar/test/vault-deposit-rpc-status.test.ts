import { describe, expect, it } from "vitest";
import { FundDepositVerifyError, money } from "@flexipay/domain";
import { StellarSettlementAdapter } from "../src/settlement.ts";
import type { CustodialDemoWalletProvider } from "../src/demo-wallets.ts";
import type { PayoutVault } from "../src/vault-client.ts";

const VAULT_ID = "C" + "A".repeat(55);
const PAYER = "G" + "B".repeat(55);

function adapterWithFetch(
	fetchFundTx: ConstructorParameters<
		typeof StellarSettlementAdapter
	>[0]["fetchFundTx"],
): StellarSettlementAdapter {
	return new StellarSettlementAdapter({
		vault: {} as PayoutVault,
		wallets: {} as CustodialDemoWalletProvider,
		vaultId: VAULT_ID,
		rpcUrl: "https://example.invalid/rpc",
		networkPassphrase: "Test SDF Network ; September 2015",
		fetchFundTx,
	});
}

describe("CCR-23 verifyFundDeposit RPC status gate", () => {
	it("rejects FAILED before envelope decode (no binding path)", async () => {
		const adapter = adapterWithFetch(async () => ({
			status: "FAILED",
			// Deliberately invalid XDR — must not be decoded when status is FAILED.
			envelopeXdr: "AAAA-not-valid-xdr-but-must-not-be-parsed",
		}));
		await expect(
			adapter.verifyFundDeposit({
				txRef: "deadbeef",
				payer: PAYER,
				amount: money("101", "USDC"),
			}),
		).rejects.toBeInstanceOf(FundDepositVerifyError);
		try {
			await adapter.verifyFundDeposit({
				txRef: "deadbeef",
				payer: PAYER,
				amount: money("101", "USDC"),
			});
		} catch (e) {
			expect((e as FundDepositVerifyError).code).toBe("not_success");
		}
	});

	it("rejects NOT_FOUND and PENDING as unconfirmed", async () => {
		for (const status of ["NOT_FOUND", "PENDING"] as const) {
			const adapter = adapterWithFetch(async () => ({ status }));
			const err = await adapter
				.verifyFundDeposit({
					txRef: "missing",
					payer: PAYER,
					amount: money("101", "USDC"),
				})
				.catch((e) => e);
			expect(err).toBeInstanceOf(FundDepositVerifyError);
			expect((err as FundDepositVerifyError).code).toBe(
				status === "NOT_FOUND" ? "not_found" : "not_success",
			);
		}
	});
});
