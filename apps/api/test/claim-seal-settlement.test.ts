import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

const stellar = vi.hoisted(() => ({ calls: [] as Array<Record<string, string | undefined>> }));

vi.mock("@flexipay/adapter-stellar", async (importOriginal) => {
	const real = await importOriginal<typeof import("@flexipay/adapter-stellar")>();
	return {
		...real,
		createStellarSettlementAdapter: async (opts: { env: Record<string, string | undefined> }) => {
			stellar.calls.push(opts.env);
			return { adapter: { network: "stellar-fake" } };
		},
	};
});

const { createSettlement } = await import("../src/settlement.ts");
const { claimSealKeyFromEnv, sealBytes, sealClaimSecret, unsealBytes, unsealClaimSecret } = await import(
	"../src/orchestrator/claim-seal.ts"
);

const KEY = Buffer.from("b".repeat(64), "hex");

describe("claim seal (CCR-11, AES-256-GCM)", () => {
	it("needs exactly 64 hex characters", () => {
		for (const bad of [undefined, "", "abc", "g".repeat(64), "a".repeat(63), "a".repeat(65)]) {
			expect(() => claimSealKeyFromEnv({ FP_CLAIM_SEAL_KEY: bad })).toThrow(/64 hex/);
		}
		expect(claimSealKeyFromEnv({ FP_CLAIM_SEAL_KEY: ` ${"A".repeat(64)} ` })).toHaveLength(32);
	});

	it("round-trips a secret with a fresh nonce each time", () => {
		const a = sealClaimSecret("ab".repeat(32), KEY);
		const b = sealClaimSecret("ab".repeat(32), KEY);
		expect(a.nonce.equals(b.nonce)).toBe(false);
		expect(a.sealed.toString("hex")).not.toContain("ab".repeat(32));
		expect(unsealClaimSecret(a.sealed, a.nonce, KEY)).toBe("ab".repeat(32));
	});

	it("refuses a short, tampered or wrongly keyed secret", () => {
		const { sealed, nonce } = sealClaimSecret("cd".repeat(32), KEY);
		expect(() => unsealClaimSecret(Buffer.alloc(15), nonce, KEY)).toThrow(/too short/);
		const tampered = Buffer.from(sealed);
		tampered[0] = tampered[0]! ^ 1;
		expect(() => unsealClaimSecret(tampered, nonce, KEY)).toThrow();
		expect(() => unsealClaimSecret(sealed, nonce, Buffer.alloc(32, 7))).toThrow();
	});

	it("seals arbitrary bytes as ArrayBuffer-backed arrays and refuses tampering", () => {
		const plain = Buffer.from("envelope-xdr-base64", "utf8");
		const { sealed, nonce } = sealBytes(plain, KEY);
		expect(sealed).toBeInstanceOf(Uint8Array);
		expect(Buffer.isBuffer(sealed)).toBe(false);
		expect(unsealBytes(Buffer.from(sealed), Buffer.from(nonce), KEY).equals(plain)).toBe(true);
		expect(() => unsealBytes(Buffer.alloc(8), Buffer.from(nonce), KEY)).toThrow(/too short/);
		const tampered = Buffer.from(sealed);
		tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 1;
		expect(() => unsealBytes(tampered, Buffer.from(nonce), KEY)).toThrow();
	});
});

describe("createSettlement (FP_SETTLEMENT)", () => {
	it("mock without an ids file uses the caller env and falls back to 100 bps on a bad fee", async () => {
		const { mode, adapter } = await createSettlement({
			env: { FP_SETTLEMENT: "mock", FP_VAULT_FEE_BPS: "1.5" },
			idsPath: "/nonexistent/testnet-ids.env",
		});
		expect(mode).toBe("mock");
		expect(await adapter.feeBps()).toBe(100);
	});

	it("mock with skipBaselineIds reads only the given env", async () => {
		const { adapter } = await createSettlement({
			env: { FP_SETTLEMENT: "mock", FP_VAULT_FEE_BPS: "25" },
			skipBaselineIds: true,
		});
		expect(await adapter.feeBps()).toBe(25);
	});

	it("stellar loads the ids file, overlays the caller env, and skips a missing secrets file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-settle-"));
		const ids = join(dir, "ids.env");
		writeFileSync(ids, "FP_PAYOUT_VAULT_ID=CFROMFILE\nFP_VAULT_FEE_BPS=100\n");
		stellar.calls.length = 0;
		const { mode, adapter } = await createSettlement({
			env: { FP_SETTLEMENT: "stellar", FP_VAULT_FEE_BPS: "50" },
			idsPath: ids,
			secretsPath: join(dir, "missing.env"),
		});
		expect(mode).toBe("stellar");
		expect(adapter.network).toBe("stellar-fake");
		expect(stellar.calls[0]!.FP_PAYOUT_VAULT_ID).toBe("CFROMFILE");
		expect(stellar.calls[0]!.FP_VAULT_FEE_BPS).toBe("50");
	});

	it("stellar with skipBaselineIds uses the env, plus the secrets file when it exists", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-settle-"));
		const secrets = join(dir, "secrets.env");
		writeFileSync(secrets, "FP_PAYER_DEMO_SECRET=SFROMFILE\nFP_PAYOUT_VAULT_ID=CFROMSECRETS\n");
		stellar.calls.length = 0;
		await createSettlement({
			env: { FP_SETTLEMENT: "stellar", FP_PAYOUT_VAULT_ID: "CMAPPED" },
			skipBaselineIds: true,
			secretsPath: secrets,
		});
		expect(stellar.calls[0]!.FP_PAYER_DEMO_SECRET).toBe("SFROMFILE");
		// The caller's mapped overlay wins over the file.
		expect(stellar.calls[0]!.FP_PAYOUT_VAULT_ID).toBe("CMAPPED");

		stellar.calls.length = 0;
		await createSettlement({
			env: { FP_SETTLEMENT: "stellar", FP_PAYOUT_VAULT_ID: "CONLY" },
			skipBaselineIds: true,
			secretsPath: join(dir, "missing.env"),
		});
		expect(stellar.calls[0]).toEqual({ FP_SETTLEMENT: "stellar", FP_PAYOUT_VAULT_ID: "CONLY" });
	});
});
