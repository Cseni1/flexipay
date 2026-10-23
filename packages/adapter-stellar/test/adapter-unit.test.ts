import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	CustodialDemoWalletProvider,
	UnknownDemoWalletError,
	parseEnvFile,
	settlementModeFromEnv,
} from "../src/index.ts";

describe("settlementModeFromEnv", () => {
	it("defaults to mock", () => {
		expect(settlementModeFromEnv({})).toBe("mock");
	});

	it("accepts mock and stellar", () => {
		expect(settlementModeFromEnv({ FP_SETTLEMENT: "mock" })).toBe("mock");
		expect(settlementModeFromEnv({ FP_SETTLEMENT: "STELLAR" })).toBe("stellar");
	});

	it("rejects other values", () => {
		expect(() => settlementModeFromEnv({ FP_SETTLEMENT: "mainnet" })).toThrow(/FP_SETTLEMENT/);
	});
});

describe("CustodialDemoWalletProvider", () => {
	const testnetDir = fileURLToPath(new URL("../../../scripts/testnet/", import.meta.url));
	const ids = parseEnvFile(readFileSync(`${testnetDir}testnet-ids.env`, "utf8"));
	const secretsFile = `${testnetDir}.env.secrets`;
	const hasSecrets = existsSync(secretsFile);

	it.skipIf(!hasSecrets)("lists labelled custodial wallets and never exposes secrets", () => {
		const secrets = parseEnvFile(readFileSync(secretsFile, "utf8"));
		const wallets = CustodialDemoWalletProvider.fromEnv({ ...ids, ...secrets });
		const listed = wallets.list();
		expect(listed).toHaveLength(3);
		for (const w of listed) {
			expect(w.custodial).toBe(true);
			expect(w.simulated).toBe(true);
			expect(w.label).toMatch(/Custodial demo/);
			expect(JSON.stringify(w)).not.toMatch(/^S[A-Z0-9]{55}$/m);
		}
		expect(wallets.addressOf("worker_a")).toBe(ids.FP_RECIPIENT_A_ADDRESS);
		expect(() => wallets.keypairForAddress("GUNKNOWN")).toThrow(UnknownDemoWalletError);
	});
});
