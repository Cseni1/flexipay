import { describe, expect, it } from "vitest";
import {
	assertAssetIdentity,
	classicAssetLine,
	parseClassicAssetLine,
	sameAsset,
	sep38AssetString,
} from "../src/anchor-asset.ts";

const NET = "Test SDF Network ; September 2015";
const ANCHOR_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const VAULT_ISSUER = "GBBO6NQEGSK2F7FRGQSRHJK4FD465H5DVALNTCT6XZJIZHKJRSPKEIY2";

describe("Stellar asset identity", () => {
	it("refuses ticker-only asset lines", () => {
		expect(() => parseClassicAssetLine("USDC", NET)).toThrow(/ticker-only/);
	});

	it("parses CODE:ISSUER and builds SEP-38 / classic forms", () => {
		const asset = parseClassicAssetLine(`USDC:${ANCHOR_ISSUER}`, NET, "CABC");
		expect(classicAssetLine(asset)).toBe(`USDC:${ANCHOR_ISSUER}`);
		expect(sep38AssetString(asset)).toBe(
			`stellar:USDC:${ANCHOR_ISSUER}`,
		);
		expect(asset.contractId).toBe("CABC");
	});

	it("distinguishes vault USDC from anchor USDC by issuer", () => {
		const anchor = parseClassicAssetLine(`USDC:${ANCHOR_ISSUER}`, NET);
		const vault = parseClassicAssetLine(`USDC:${VAULT_ISSUER}`, NET);
		expect(sameAsset(anchor, vault)).toBe(false);
		expect(sameAsset(anchor, anchor)).toBe(true);
	});

	it("requires network passphrase", () => {
		expect(() =>
			assertAssetIdentity({
				code: "USDC",
				issuer: ANCHOR_ISSUER,
				networkPassphrase: "",
			}),
		).toThrow(/networkPassphrase/);
	});
});
