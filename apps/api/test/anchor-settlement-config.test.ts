import { describe, expect, it } from "vitest";
import {
	AnchorSettlementConfigError,
	mapAnchorVaultToSettlementEnv,
} from "../src/anchor/settlement-from-anchor-env.ts";

const BASELINE = {
	FP_STELLAR_NETWORK: "testnet",
	FP_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
	FP_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
	FP_USDC_ASSET: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	FP_USDC_CONTRACT_ID: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	FP_PAYOUT_VAULT_ID: "CBASELINEVAULT000000000000000000000000000000000000000",
	FP_VAULT_FEE_BPS: "100",
	FP_TREASURY_ADDRESS: "GBASELINETREASURY00000000000000000000000000000000000",
};

const ANCHOR = {
	FP_ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
	FP_ANCHOR_USDC_ASSET:
		"USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
	FP_ANCHOR_USDC_CONTRACT_ID:
		"CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
	FP_ANCHOR_VAULT_ID: "CA5SYMIWGCUGG6OVTL3KBFNOWVEF46UILNKG7D7JMAD7XVQWX2W3ETMS",
	FP_ANCHOR_VAULT_FEE_BPS: "100",
	FP_ANCHOR_VAULT_TREASURY_ADDRESS:
		"GDH7WGAQJQUBQBYNN3SO4QWWWXRYR6GWQTM5BZ3RCGXFDCOI4QTUHHXR",
	FP_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
};

describe("CCR-22 anchor settlement config mapping", () => {
	it("maps FP_ANCHOR_VAULT_* onto settlement factory keys and validates", () => {
		const mapping = mapAnchorVaultToSettlementEnv({
			...BASELINE,
			...ANCHOR,
			// Distinct baseline asset so mix check passes
			FP_USDC_ASSET:
				"USDC:GBBO6N7U5E4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHN4",
		});
		expect(mapping.settlementEnv.FP_PAYOUT_VAULT_ID).toBe(
			ANCHOR.FP_ANCHOR_VAULT_ID,
		);
		expect(mapping.settlementEnv.FP_USDC_ASSET).toBe(ANCHOR.FP_ANCHOR_USDC_ASSET);
		expect(mapping.settlementEnv.FP_TREASURY_ADDRESS).toBe(
			ANCHOR.FP_ANCHOR_VAULT_TREASURY_ADDRESS,
		);
		expect(mapping.stellar.payoutVaultId).toBe(ANCHOR.FP_ANCHOR_VAULT_ID);
		expect(mapping.baselineVaultId).toBe(BASELINE.FP_PAYOUT_VAULT_ID);
	});

	it("refuses when anchor vault id equals baseline vault id", () => {
		expect(() =>
			mapAnchorVaultToSettlementEnv({
				...BASELINE,
				...ANCHOR,
				FP_USDC_ASSET:
					"USDC:GBBO6N7U5E4AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAHN4",
				FP_ANCHOR_VAULT_ID: BASELINE.FP_PAYOUT_VAULT_ID,
			}),
		).toThrow(AnchorSettlementConfigError);
	});

	it("refuses when anchor asset equals baseline asset", () => {
		expect(() =>
			mapAnchorVaultToSettlementEnv({
				...BASELINE,
				...ANCHOR,
				FP_USDC_ASSET: ANCHOR.FP_ANCHOR_USDC_ASSET,
			}),
		).toThrow(AnchorSettlementConfigError);
	});
});
