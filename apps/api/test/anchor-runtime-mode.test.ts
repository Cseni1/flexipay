import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@flexipay/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createApiRuntime } from "../src/runtime.ts";

const configDir = resolve(
	fileURLToPath(new URL("../../../config", import.meta.url)),
);

const ANCHOR_ENV = {
	FP_SETTLEMENT: "mock",
	FP_CLAIM_SEAL_KEY: "a".repeat(64),
	FP_API_URL: "http://127.0.0.1",
	FP_STELLAR_NETWORK: "testnet",
	FP_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
	FP_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
	// Baseline distinct from anchor
	FP_USDC_ASSET: "USDC:GBBO6N7U5E4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHN4",
	FP_USDC_CONTRACT_ID: "CBASELINEUSDC000000000000000000000000000000000000000",
	FP_PAYOUT_VAULT_ID: "CBASELINEVAULT000000000000000000000000000000000000000",
	FP_VAULT_FEE_BPS: "100",
	FP_TREASURY_ADDRESS: "GBASELINETREASURY00000000000000000000000000000000000",
	FP_ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
	FP_ANCHOR_USDC_ASSET:
		"USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	FP_ANCHOR_USDC_CONTRACT_ID:
		"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	FP_ANCHOR_VAULT_ID: "CA5SYMIWGCUGG6OVTL3KBFNOWVEF46UILNKG7D7JMAD7XVQWX2W3ETMS",
	FP_ANCHOR_VAULT_FEE_BPS: "100",
	FP_ANCHOR_VAULT_TREASURY_ADDRESS:
		"GDH7WGAQJQUBQBYNN3SO4QWWWXRYR6GWQTM5BZ3RCGXFDCOI4QTUHHXR",
};

describe("FP_ANCHOR_MODE createApiRuntime", () => {
	afterEach(() => {
		delete process.env.FP_ANCHOR_MODE;
	});

	it("baseline mode unchanged when FP_ANCHOR_MODE unset", async () => {
		const loaded = await loadConfig(configDir);
		if (!loaded.ok) throw new Error("config invalid");
		const runtime = await createApiRuntime(loaded.config, {
			...ANCHOR_ENV,
			FP_ANCHOR_MODE: undefined,
		});
		expect(runtime.anchorMode).toBe(false);
		expect(runtime.settlementSimulated).toBe(true);
		expect(runtime.anchorAsset).toBeUndefined();
	});

	it("FP_ANCHOR_MODE=1 refuses a mock or unset settlement instead of mislabelling it", async () => {
		const loaded = await loadConfig(configDir);
		if (!loaded.ok) throw new Error("config invalid");
		for (const FP_SETTLEMENT of ["mock", undefined]) {
			await expect(
				createApiRuntime(loaded.config, {
					...ANCHOR_ENV,
					FP_SETTLEMENT,
					FP_ANCHOR_MODE: "1",
				}),
			).rejects.toThrow(/requires FP_SETTLEMENT=stellar/);
		}
	});

	// The positive path (anchor vault and asset selected, vault config verified against
	// FP_ANCHOR_VAULT_FEE_BPS and the anchor USDC contract) needs the payer secret and the
	// testnet RPC, so it is exercised only in the live M1/DF7 acceptance run.

	it("FP_ANCHOR_MODE=1 fail-fast when anchor vault missing", async () => {
		const loaded = await loadConfig(configDir);
		if (!loaded.ok) throw new Error("config invalid");
		await expect(
			createApiRuntime(loaded.config, {
				...ANCHOR_ENV,
				FP_SETTLEMENT: "stellar",
				FP_ANCHOR_MODE: "1",
				FP_ANCHOR_VAULT_ID: "",
			}),
		).rejects.toThrow(/FP_ANCHOR_VAULT_ID|Missing/);
	});
});
