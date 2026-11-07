import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Keypair, Networks, StrKey } from "@stellar/stellar-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	CustodialDemoWalletProvider,
	UnknownDemoWalletError,
} from "../src/demo-wallets.ts";
import { createStellarSettlementAdapter, loadTestnetEnvFiles } from "../src/factory.ts";
import { PayoutVault } from "../src/vault-client.ts";

const payer = Keypair.random();
const a = Keypair.random();
const b = Keypair.random();
const walletEnv = {
	FP_PAYER_DEMO_ADDRESS: payer.publicKey(),
	FP_PAYER_DEMO_SECRET: payer.secret(),
	FP_RECIPIENT_A_ADDRESS: a.publicKey(),
	FP_RECIPIENT_A_SECRET: a.secret(),
	FP_RECIPIENT_B_ADDRESS: b.publicKey(),
	FP_RECIPIENT_B_SECRET: b.secret(),
};
const VAULT_ID = StrKey.encodeContract(Buffer.alloc(32, 7));
const stellarEnv = {
	FP_STELLAR_NETWORK: "testnet",
	FP_STELLAR_RPC_URL: "https://rpc.invalid",
	FP_STELLAR_NETWORK_PASSPHRASE: Networks.TESTNET,
	FP_USDC_ASSET: "USDC:GXXX",
	FP_USDC_CONTRACT_ID: StrKey.encodeContract(Buffer.alloc(32, 9)),
	FP_PAYOUT_VAULT_ID: VAULT_ID,
	FP_VAULT_FEE_BPS: "100",
	FP_TREASURY_ADDRESS: Keypair.random().publicKey(),
};

afterEach(() => vi.restoreAllMocks());

describe("CustodialDemoWalletProvider (generated keys)", () => {
	const wallets = CustodialDemoWalletProvider.fromEnv(walletEnv);

	it("lists payer + two recipients, labelled custodial, no secrets", () => {
		const listed = wallets.list();
		expect(listed.map((w) => [w.id, w.role])).toEqual([
			["payer_demo", "payer"],
			["worker_a", "recipient"],
			["worker_b", "recipient"],
		]);
		const text = JSON.stringify(listed);
		for (const kp of [payer, a, b]) expect(text).not.toContain(kp.secret());
		expect(listed.every((w) => w.custodial && w.simulated)).toBe(true);
	});

	it("get / addressOf / hasAddress / keypairForAddress", () => {
		expect(wallets.get("worker_b").address).toBe(b.publicKey());
		expect(wallets.addressOf("payer_demo")).toBe(payer.publicKey());
		expect(wallets.hasAddress(a.publicKey())).toBe(true);
		expect(wallets.hasAddress(Keypair.random().publicKey())).toBe(false);
		expect(wallets.keypairForAddress(a.publicKey()).secret()).toBe(a.secret());
		expect(() => wallets.get("nobody")).toThrow(UnknownDemoWalletError);
		expect(() => wallets.addressOf("nobody")).toThrow(/unknown demo wallet id: nobody/);
	});

	it("fails on missing address, missing secret or address/secret mismatch", () => {
		expect(() =>
			CustodialDemoWalletProvider.fromEnv({ ...walletEnv, FP_RECIPIENT_B_ADDRESS: undefined }),
		).toThrow("Missing demo wallet address: FP_RECIPIENT_B_ADDRESS");
		expect(() =>
			CustodialDemoWalletProvider.fromEnv({ ...walletEnv, FP_PAYER_DEMO_SECRET: "" }),
		).toThrow("Missing demo wallet secret: FP_PAYER_DEMO_SECRET");
		expect(() =>
			CustodialDemoWalletProvider.fromEnv({ ...walletEnv, FP_RECIPIENT_A_SECRET: b.secret() }),
		).toThrow("FP_RECIPIENT_A_ADDRESS does not match the public key of FP_RECIPIENT_A_SECRET");
	});
});

describe("createStellarSettlementAdapter", () => {
	it("connects the vault (verify by default) and wires the adapter", async () => {
		const fakeVault = {} as PayoutVault;
		const connect = vi.spyOn(PayoutVault, "connect").mockResolvedValue(fakeVault);
		const out = await createStellarSettlementAdapter({
			env: { ...stellarEnv, ...walletEnv },
			assetCurrency: "USDC",
		});
		expect(connect).toHaveBeenCalledWith(
			expect.objectContaining({ payoutVaultId: VAULT_ID, vaultFeeBps: 100 }),
			{ verify: true },
		);
		expect(out.adapter.network).toBe("stellar");
		expect(out.adapter.vaultId).toBe(VAULT_ID);
		expect(out.env.rpcUrl).toBe("https://rpc.invalid");
		expect(out.wallets.addressOf("worker_a")).toBe(a.publicKey());
	});

	it("passes verifyConfig: false through", async () => {
		const connect = vi.spyOn(PayoutVault, "connect").mockResolvedValue({} as PayoutVault);
		await createStellarSettlementAdapter({ env: { ...stellarEnv, ...walletEnv }, verifyConfig: false });
		expect(connect.mock.calls[0]![1]).toEqual({ verify: false });
	});

	it("fails fast on missing Stellar settings before connecting", async () => {
		const connect = vi.spyOn(PayoutVault, "connect");
		await expect(createStellarSettlementAdapter({ env: walletEnv })).rejects.toThrow(
			/Missing Stellar settings/,
		);
		expect(connect).not.toHaveBeenCalled();
	});

	it("propagates config mismatch from connect", async () => {
		vi.spyOn(PayoutVault, "connect").mockRejectedValue(new Error("payout_vault config does not match"));
		await expect(
			createStellarSettlementAdapter({ env: { ...stellarEnv, ...walletEnv } }),
		).rejects.toThrow(/does not match/);
	});
});

describe("loadTestnetEnvFiles", () => {
	const dir = mkdtempSync(join(tmpdir(), "fp-env-"));
	const ids = join(dir, "ids.env");
	const secrets = join(dir, "secrets.env");
	writeFileSync(ids, "# ids\nFP_A=1\nFP_B=\"two\"\n");
	writeFileSync(secrets, "FP_B=secret-two\nFP_C=3\n");

	it("merges ids, then secrets, then overlay (later wins)", () => {
		expect(loadTestnetEnvFiles({ idsPath: ids })).toEqual({ FP_A: "1", FP_B: "two" });
		expect(
			loadTestnetEnvFiles({ idsPath: ids, secretsPath: secrets, overlay: { FP_C: "x" } }),
		).toEqual({ FP_A: "1", FP_B: "secret-two", FP_C: "x" });
	});

	it("throws on a missing ids file", () => {
		expect(() => loadTestnetEnvFiles({ idsPath: join(dir, "nope.env") })).toThrow(/ENOENT/);
	});
});
