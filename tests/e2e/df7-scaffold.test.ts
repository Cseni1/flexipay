import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import { AssertionFailure } from "../../scripts/demo/lib/assertions.ts"
import {
	assertSeparateDf7Refs,
	checkDf7Prerequisites,
	classifyDf7Lifecycle,
	df7RefProblems,
	parseDf7Amount,
	planDf7Stages,
	saveHostedUrlForBrowser,
} from "../../scripts/demo/lib/df7-lifecycle.ts"

// These tests are local only: no anchor call, no testnet transaction.

const TESTNET = "Test SDF Network ; September 2015"
const baselineVault = StrKey.encodeContract(Buffer.alloc(32, 1))
const anchorVault = StrKey.encodeContract(Buffer.alloc(32, 2))
const anchorSac = StrKey.encodeContract(Buffer.alloc(32, 3))
const baselineSac = StrKey.encodeContract(Buffer.alloc(32, 4))
const anchorIssuer = Keypair.random().publicKey()
const baselineIssuer = Keypair.random().publicKey()
const treasury = Keypair.random().publicKey()
const recipient = Keypair.random()

const publicEnv = (overrides: Record<string, string> = {}) => ({
	FP_ANCHOR_HOME_DOMAIN: "testanchor.stellar.org",
	FP_STELLAR_NETWORK_PASSPHRASE: TESTNET,
	FP_ANCHOR_USDC_ASSET: `USDC:${anchorIssuer}`,
	FP_ANCHOR_USDC_CONTRACT_ID: anchorSac,
	FP_ANCHOR_VAULT_ID: anchorVault,
	FP_ANCHOR_VAULT_FEE_BPS: "100",
	FP_ANCHOR_VAULT_TREASURY_ADDRESS: treasury,
	FP_ANCHOR_VAULT_PURPOSE: "reference-anchor-usdc-m1",
	FP_RECIPIENT_A_ADDRESS: recipient.publicKey(),
	...overrides,
})

const baselineEnv = (overrides: Record<string, string> = {}) => ({
	FP_PAYOUT_VAULT_ID: baselineVault,
	FP_USDC_ASSET: `USDC:${baselineIssuer}`,
	FP_USDC_CONTRACT_ID: baselineSac,
	FP_STELLAR_NETWORK_PASSPHRASE: TESTNET,
	...overrides,
})

const refs = {
	anchorTransactionId: "sep24-anchor-id-1",
	anchorPaymentHash: "a".repeat(64),
	vaultReleaseHash: "b".repeat(64),
}

describe("DF7 prerequisites", () => {
	it("accepts Cursor's CCR-20 shape and the matching recipient secret", () => {
		const result = checkDf7Prerequisites({
			publicEnv: publicEnv(),
			baselineEnv: baselineEnv(),
			secretEnv: { FP_RECIPIENT_A_SECRET: recipient.secret() },
			requireSecret: true,
		})
		expect(result.blockers).toEqual([])
		expect(result.env?.anchorVaultId).toBe(anchorVault)
		expect(result.env?.asset.issuer).toBe(anchorIssuer)
		expect(result.recipient?.publicKey()).toBe(recipient.publicKey())
	})

	it("rejects the baseline vault, the baseline asset and a wrong secret", () => {
		const sameVault = checkDf7Prerequisites({
			publicEnv: publicEnv({ FP_ANCHOR_VAULT_ID: baselineVault }),
			baselineEnv: baselineEnv(),
			requireSecret: false,
		})
		expect(sameVault.blockers.map((b) => b.what).join(" ")).toMatch(
			/anchor vault id equals/,
		)

		const sameAsset = checkDf7Prerequisites({
			publicEnv: publicEnv({
				FP_ANCHOR_USDC_ASSET: `USDC:${baselineIssuer}`,
				FP_ANCHOR_USDC_CONTRACT_ID: baselineSac,
			}),
			baselineEnv: baselineEnv(),
			requireSecret: false,
		})
		expect(sameAsset.blockers.map((b) => b.what).join(" ")).toMatch(
			/anchor USDC asset equals|anchor USDC contract id equals/,
		)

		const secret = Keypair.random().secret()
		const wrongSecret = checkDf7Prerequisites({
			publicEnv: publicEnv(),
			baselineEnv: baselineEnv(),
			secretEnv: { FP_RECIPIENT_A_SECRET: secret },
			requireSecret: true,
		})
		expect(wrongSecret.blockers.map((b) => b.what).join(" ")).toMatch(
			/does not match/,
		)
		expect(JSON.stringify(wrongSecret.blockers)).not.toContain(secret)
	})

	it("reports missing public ids without inventing values", () => {
		const missing = checkDf7Prerequisites({
			publicEnv: {},
			baselineEnv: baselineEnv(),
			requireSecret: false,
		})
		expect(missing.blockers.length).toBeGreaterThan(0)
		expect(missing.blockers.map((b) => b.what).join(" ")).toMatch(
			/FP_ANCHOR_HOME_DOMAIN/,
		)

		const missingBaseline = checkDf7Prerequisites({
			publicEnv: publicEnv(),
			baselineEnv: {},
			requireSecret: false,
		})
		expect(missingBaseline.blockers.map((b) => b.what).join(" ")).toMatch(
			/FP_PAYOUT_VAULT_ID/,
		)
	})
})

describe("DF7 references", () => {
	it("requires three present, distinct refs", () => {
		expect(df7RefProblems(refs)).toEqual([])
		expect(() => assertSeparateDf7Refs(refs)).not.toThrow()

		expect(df7RefProblems({})).toHaveLength(3)
		expect(
			df7RefProblems({ ...refs, vaultReleaseHash: refs.anchorPaymentHash }),
		).toContain(
			"anchor payment hash and vault release hash are the same transaction; keep them separate",
		)
		expect(() =>
			assertSeparateDf7Refs({
				...refs,
				vaultReleaseHash: refs.anchorPaymentHash,
			}),
		).toThrow(AssertionFailure)
	})
})

describe("DF7 lifecycle classification", () => {
	it("is SUCCESS only with completed, a passed assertion and all three refs", () => {
		expect(
			classifyDf7Lifecycle({
				anchorStatus: "completed",
				refs,
				withdrawAssertion: "pass",
			}),
		).toMatchObject({ outcome: "SUCCESS" })
	})

	it("keeps completed-with-missing-evidence PENDING, never success", () => {
		const missing = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs: { ...refs, vaultReleaseHash: undefined },
			withdrawAssertion: "pass",
		})
		expect(missing.outcome).toBe("PENDING")
		expect(missing.reasons.join(" ")).toMatch(/vault release hash/)

		const notAsserted = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			withdrawAssertion: "not-run",
		})
		expect(notAsserted.outcome).toBe("PENDING")
		expect(notAsserted.reasons.join(" ")).toMatch(/assertion was not run/)

		const failedAssertion = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			withdrawAssertion: "fail",
		})
		expect(failedAssertion.outcome).toBe("FAILURE")
		// A failed assertion is a failure even when refs are also missing.
		expect(
			classifyDf7Lifecycle({
				anchorStatus: "completed",
				refs: {},
				withdrawAssertion: "fail",
			}).outcome,
		).toBe("FAILURE")
	})

	it("classifies terminal failures, pending statuses and bounded timeouts honestly", () => {
		expect(classifyDf7Lifecycle({ anchorStatus: "expired" }).outcome).toBe(
			"FAILURE",
		)
		expect(
			classifyDf7Lifecycle({ anchorStatus: "pending_user_transfer_start" })
				.outcome,
		).toBe("PENDING")
		const timeout = classifyDf7Lifecycle({
			anchorStatus: undefined,
			timedOut: true,
			refs,
			withdrawAssertion: "not-run",
		})
		expect(timeout.outcome).toBe("PENDING")
		expect(timeout.reasons.join(" ")).toMatch(/INCOMPLETE/)
		expect(classifyDf7Lifecycle({ prerequisitesOk: false }).outcome).toBe(
			"BLOCKED",
		)
	})
})

describe("DF7 hosted URL handling", () => {
	it("keeps the functional URL in a 0600 file and logs only the sanitised URL", () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-url-"))
		try {
			const full =
				"https://anchor-ref-ui-testanchor.stellar.org/session/abc?token=not-for-logs#fragment"
			const saved = saveHostedUrlForBrowser(full, dir)
			expect(saved.urlSanitised).toBe(
				"https://anchor-ref-ui-testanchor.stellar.org/session/abc",
			)
			expect(saved.urlSanitised).not.toContain("token")
			expect(readFileSync(saved.path, "utf8")).toBe(full)
			expect(statSync(saved.path).mode & 0o777).toBe(0o600)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("accepts only the test-anchor amount range", () => {
		expect(parseDf7Amount("1")).toBe("1")
		expect(parseDf7Amount("10")).toBe("10")
		expect(parseDf7Amount("1.5")).toBe("1.5")
		expect(() => parseDf7Amount("0")).toThrow()
		expect(() => parseDf7Amount("10.1")).toThrow()
		expect(() => parseDf7Amount("1.12345678")).toThrow()
	})
})

describe("DF7 stage plan", () => {
	it("keeps payment NotImplemented and reports the stages in order", () => {
		const stages = planDf7Stages(true)
		expect(stages.map((s) => s.id)).toEqual([
			"prerequisites",
			"vault_release",
			"discover",
			"authenticate",
			"price",
			"start_withdraw",
			"hosted_interactive",
			"anchor_payment",
			"poll_terminal",
			"classify",
		])
		expect(stages.find((s) => s.id === "anchor_payment")?.status).toBe(
			"NOT_IMPLEMENTED",
		)
		expect(planDf7Stages(false)[0]?.status).toBe("BLOCKED")
	})
})
