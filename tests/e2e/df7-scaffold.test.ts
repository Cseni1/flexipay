import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
	Account,
	Keypair,
	StrKey,
	type Transaction,
} from "@stellar/stellar-sdk"
import { describe, expect, it } from "vitest"
import {
	buildAndSignClassicPaymentWithMemo,
	type AnchorPaymentExpectation,
	type ClassicPaymentHorizon,
} from "../../packages/adapter-stellar/src/index.ts"
import { AssertionFailure } from "../../scripts/demo/lib/assertions.ts"
import {
	anchorDeclaredAsset,
	assertDf7Refs,
	checkDf7PaymentGates,
	checkDf7Prerequisites,
	classifyDf7Lifecycle,
	decimalEquals,
	df7RefProblems,
	encodeSignedPayment,
	parseDf7Amount,
	planDf7Stages,
	createDf7PaymentState,
	readDf7PaymentState,
	reconcileAnchorPayment,
	updateDf7PaymentState,
	saveHostedUrlForBrowser,
	validateAnchorPayment,
	verifyAnchorCompletion,
	type Df7PaymentState,
	type HorizonTransactionRecord,
} from "../../scripts/demo/lib/df7-lifecycle.ts"

// These tests are local only: no anchor call, no Horizon call, no testnet
// transaction. Horizon records are fixtures shaped like the REST payload.

const TESTNET = "Test SDF Network ; September 2015"
const baselineVault = StrKey.encodeContract(Buffer.alloc(32, 1))
const anchorVault = StrKey.encodeContract(Buffer.alloc(32, 2))
const anchorSac = StrKey.encodeContract(Buffer.alloc(32, 3))
const baselineSac = StrKey.encodeContract(Buffer.alloc(32, 4))
const anchorIssuer = Keypair.random().publicKey()
const baselineIssuer = Keypair.random().publicKey()
const treasury = Keypair.random().publicKey()
const recipient = Keypair.random()
const anchorAccount = Keypair.random().publicKey()

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

const anchorAsset = {
	code: "USDC",
	issuer: anchorIssuer,
	networkPassphrase: TESTNET,
}

const expectation: AnchorPaymentExpectation = {
	asset: anchorAsset,
	amount: "1",
	destination: anchorAccount,
	memo: "2304272553721027745",
	memoType: "id",
}

const refs = {
	anchorTransactionId: "sep24-anchor-id-1",
	anchorPaymentHash: "a".repeat(64),
	vaultReleaseHash: "b".repeat(64),
}

const proof = {
	anchorTransactionIdVerified: true,
	anchorPaymentHashVerified: true,
	vaultReleaseHashVerified: true,
}

const horizonTx = (
	over: Partial<HorizonTransactionRecord> = {},
): HorizonTransactionRecord => ({
	hash: "c".repeat(64),
	successful: true,
	memo: expectation.memo,
	memo_type: "id",
	operations: [
		{
			type: "payment",
			destination: anchorAccount,
			asset_type: "credit_alphanum4",
			asset_code: "USDC",
			asset_issuer: anchorIssuer,
			amount: "1.0000000",
		},
	],
	...over,
})

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
	it("requires three present refs but does not infer roles from string inequality", () => {
		expect(df7RefProblems(refs)).toEqual([])
		expect(() => assertDf7Refs(refs)).not.toThrow()
		expect(df7RefProblems({})).toHaveLength(3)

		// Identical values are not a problem by themselves: each reference is
		// validated against the source and role that produced it.
		expect(
			df7RefProblems({
				...refs,
				vaultReleaseHash: refs.anchorPaymentHash,
			}),
		).toEqual([])

		expect(() =>
			assertDf7Refs({ ...refs, anchorPaymentHash: "not-a-hash" }),
		).toThrow(AssertionFailure)
	})
})

describe("DF7 lifecycle classification", () => {
	it("is SUCCESS only with completed, verified refs and a passed assertion", () => {
		expect(
			classifyDf7Lifecycle({
				anchorStatus: "completed",
				refs,
				proof,
				withdrawAssertion: "pass",
				anchorStellarTransactionId: refs.anchorPaymentHash,
			}),
		).toMatchObject({ outcome: "SUCCESS" })
	})

	it("keeps completed with missing evidence NOT_VERIFIED, never success", () => {
		const missingRef = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs: { ...refs, vaultReleaseHash: undefined },
			proof,
			withdrawAssertion: "pass",
			anchorStellarTransactionId: refs.anchorPaymentHash,
		})
		expect(missingRef.outcome).toBe("NOT_VERIFIED")
		expect(missingRef.reasons.join(" ")).toMatch(/vault release hash/)

		const unverifiedRef = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			proof: { ...proof, anchorPaymentHashVerified: false },
			withdrawAssertion: "pass",
			anchorStellarTransactionId: refs.anchorPaymentHash,
		})
		expect(unverifiedRef.outcome).toBe("NOT_VERIFIED")
		expect(unverifiedRef.reasons.join(" ")).toMatch(/not verified/)

		const notAsserted = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			proof,
			withdrawAssertion: "not-run",
			anchorStellarTransactionId: refs.anchorPaymentHash,
		})
		expect(notAsserted.outcome).toBe("NOT_VERIFIED")
		expect(notAsserted.reasons.join(" ")).toMatch(/assertion was not run/)

		const missingPayment = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			proof,
			paymentProblems: ["anchor did not publish amount_in"],
			withdrawAssertion: "not-run",
			anchorStellarTransactionId: refs.anchorPaymentHash,
		})
		expect(missingPayment.outcome).toBe("NOT_VERIFIED")
		expect(missingPayment.reasons.join(" ")).toMatch(/amount_in/)
	})

	it("classifies a confirmed payment mismatch as FAILURE even when refs exist", () => {
		const mismatch = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			proof,
			withdrawAssertion: "pass",
			paymentMismatch: true,
			anchorStellarTransactionId: refs.anchorPaymentHash,
		})
		expect(mismatch.outcome).toBe("FAILURE")

		const failedAssertion = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			proof,
			withdrawAssertion: "fail",
			anchorStellarTransactionId: refs.anchorPaymentHash,
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

	it("requires completed plus a matching stellar_transaction_id for M1 PASS", () => {
		expect(
			classifyDf7Lifecycle({
				anchorStatus: "pending_user_transfer_start",
				refs,
				proof,
				withdrawAssertion: "pass",
				anchorStellarTransactionId: refs.anchorPaymentHash,
				retainedPaymentHash: refs.anchorPaymentHash,
			}).outcome,
		).toBe("PENDING")

		expect(
			classifyDf7Lifecycle({
				anchorStatus: "completed",
				refs,
				proof,
				withdrawAssertion: "pass",
			}).outcome,
		).toBe("NOT_VERIFIED")

		const mismatched = classifyDf7Lifecycle({
			anchorStatus: "completed",
			refs,
			proof,
			withdrawAssertion: "pass",
			anchorStellarTransactionId: "f".repeat(64),
			retainedPaymentHash: refs.anchorPaymentHash,
		})
		expect(mismatched.outcome).toBe("FAILURE")
		expect(mismatched.reasons.join(" ")).toMatch(/stellar_transaction_id/)
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

describe("DF7 anchor payment fields", () => {
	it("accepts a clean pending record and records the asset source", () => {
		const request = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			expectedAmount: "1",
			anchorTransactionId: refs.anchorTransactionId,
			expectedAnchorTransactionId: refs.anchorTransactionId,
		})
		expect(request.problems).toEqual([])
		expect(request.mismatches).toEqual([])
		expect(request.assetSource).toBe("request")

		const published = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
			anchorRecord: { amount_in_asset: `USDC:${anchorIssuer}` },
		})
		expect(published.problems).toEqual([])
		expect(published.mismatches).toEqual([])
		expect(published.assetSource).toBe("anchor-record")

		const sep38 = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
			anchorRecord: {
				amount_in_asset: `stellar:USDC:${anchorIssuer}`,
			},
		})
		expect(sep38.mismatches).toEqual([])
		expect(sep38.assetSource).toBe("anchor-record")
	})

	it("rejects a wrong anchor-published asset, including ticker-only", () => {
		const wrongIssuer = Keypair.random().publicKey()
		const wrong = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
			anchorRecord: { amount_in_asset: `USDC:${wrongIssuer}` },
		})
		expect(wrong.mismatches.join(" ")).toMatch(/does not match the configured/)

		const tickerOnly = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
			anchorRecord: { amount_in_asset: "USDC" },
		})
		expect(tickerOnly.mismatches.join(" ")).toMatch(/no issuer/)
		expect(anchorDeclaredAsset({ amount_in_asset: "USDC" })).toEqual({
			code: "USDC",
			issuer: "",
		})
		expect(anchorDeclaredAsset({})).toBeUndefined()
	})

	it("rejects unsafe status, wrong amount, wrong asset and malformed fields", () => {
		const badStatus = validateAnchorPayment({
			status: "completed",
			expectation,
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
		})
		expect(badStatus.problems.join(" ")).toMatch(
			/not pending_user_transfer_start/,
		)

		const wrongAmount = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			expectedAmount: "2",
			anchorTransactionId: refs.anchorTransactionId,
		})
		expect(wrongAmount.mismatches.join(" ")).toMatch(
			/does not match the expected/,
		)

		const wrongAsset = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: { ...anchorAsset, issuer: baselineIssuer },
			anchorTransactionId: refs.anchorTransactionId,
		})
		expect(wrongAsset.mismatches.join(" ")).toMatch(/anchor asset/)

		const malformed = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation: {
				...expectation,
				destination: "not-a-g-address",
				amount: "0",
				memo: "",
				memoType: "text",
			},
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
		})
		expect(malformed.problems.join(" ")).toMatch(
			/destination is not a G-address/,
		)
		expect(malformed.problems.join(" ")).toMatch(/not a positive decimal/)
		expect(malformed.problems.join(" ")).toMatch(/memo is empty/)

		const overlongMemo = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation: { ...expectation, memo: "x".repeat(29), memoType: "text" },
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
		})
		expect(overlongMemo.problems.join(" ")).toMatch(/exceeds 28 bytes/)

		const badIdMemo = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation: { ...expectation, memo: "239a" },
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
		})
		expect(badIdMemo.problems.join(" ")).toMatch(/not a decimal id/)

		const idMismatch = validateAnchorPayment({
			status: "pending_user_transfer_start",
			expectation,
			expectedAsset: anchorAsset,
			anchorTransactionId: refs.anchorTransactionId,
			expectedAnchorTransactionId: "another-id",
		})
		expect(idMismatch.mismatches.join(" ")).toMatch(/does not match another-id/)
	})

	it("compares amounts numerically instead of by string shape", () => {
		expect(decimalEquals("1", "1.0000000")).toBe(true)
		expect(decimalEquals("0.1", "0.10")).toBe(true)
		expect(decimalEquals("1", "1.0000001")).toBe(false)
		expect(decimalEquals("1", "01")).toBe(false)
	})
})

describe("DF7 completion verification", () => {
	it("passes only when the anchor publishes matching amount, destination and memo", () => {
		expect(
			verifyAnchorCompletion({
				expectation,
				amountIn: "1.0000000",
				destination: anchorAccount,
				memo: expectation.memo,
				memoType: "id",
			}),
		).toEqual({ problems: [], mismatches: [] })
	})

	it("reports missing fields as incomplete and wrong values as mismatches", () => {
		const missing = verifyAnchorCompletion({ expectation })
		expect(missing.problems).toHaveLength(4)
		expect(missing.problems.join(" ")).toMatch(
			/memo type evidence is incomplete/,
		)
		expect(missing.mismatches).toEqual([])

		const wrongAmount = verifyAnchorCompletion({
			expectation,
			amountIn: "2",
			destination: anchorAccount,
			memo: expectation.memo,
			memoType: "id",
		})
		expect(wrongAmount.problems).toEqual([])
		expect(wrongAmount.mismatches.join(" ")).toMatch(/does not match the paid/)

		const wrongMemoType = verifyAnchorCompletion({
			expectation,
			amountIn: "1",
			destination: anchorAccount,
			memo: expectation.memo,
			memoType: "text",
		})
		expect(wrongMemoType.mismatches.join(" ")).toMatch(/memo type/)
	})
})

describe("DF7 live payment gates", () => {
	it("requires network, submit approval and a recipient-A window confirmation", () => {
		expect(checkDf7PaymentGates({}).blockers).toHaveLength(3)
		expect(
			checkDf7PaymentGates({ FP_DF7_ALLOW_NETWORK: "1" }).blockers,
		).toHaveLength(2)

		const ready = checkDf7PaymentGates({
			FP_DF7_ALLOW_NETWORK: "1",
			FP_DF7_SUBMIT_PAYMENT: "1",
			FP_DF7_RECIPIENT_LOCK: "LOCK recipient A Freebuff DF7 2026-10-25T13:00Z",
		})
		expect(ready.blockers).toEqual([])
		expect(ready.lock).toMatch(/^LOCK recipient A/)

		expect(
			checkDf7PaymentGates({
				FP_DF7_ALLOW_NETWORK: "1",
				FP_DF7_SUBMIT_PAYMENT: "1",
				FP_DF7_RECIPIENT_LOCK: "recipientA is free",
			}).blockers,
		).toHaveLength(1)
	})
})

describe("DF7 reconciliation", () => {
	it("recovers exactly one matching payment and ignores unrelated records", () => {
		const result = reconcileAnchorPayment({
			expectation,
			transactions: [
				horizonTx(),
				horizonTx({
					hash: "d".repeat(64),
					memo: "some-other-memo",
					operations: [
						{
							type: "payment",
							destination: Keypair.random().publicKey(),
							asset_type: "credit_alphanum4",
							asset_code: "USDC",
							asset_issuer: anchorIssuer,
							amount: "9.0000000",
						},
					],
				}),
			],
		})
		expect(result.outcome).toBe("RECONCILED")
		expect(result.hashes).toEqual(["c".repeat(64)])
		expect(result.inspected).toBe(2)
	})

	it("reports NOT_FOUND when no memo-carrying payment exists", () => {
		const result = reconcileAnchorPayment({
			expectation,
			transactions: [horizonTx({ memo: "unrelated" })],
		})
		expect(result.outcome).toBe("NOT_FOUND")
		expect(result.reasons.join(" ")).toMatch(/do not retry blindly/)
	})

	it("reports a failed memo-carrying attempt without calling it a payment", () => {
		const result = reconcileAnchorPayment({
			expectation,
			transactions: [horizonTx({ successful: false })],
		})
		expect(result.outcome).toBe("NOT_FOUND")
		expect(result.reasons.join(" ")).toMatch(/failed on-chain/)
	})

	it("treats a memo match with different payment fields as MISMATCH", () => {
		const wrongAmount = reconcileAnchorPayment({
			expectation,
			transactions: [
				horizonTx({
					operations: [
						{
							type: "payment",
							destination: anchorAccount,
							asset_type: "credit_alphanum4",
							asset_code: "USDC",
							asset_issuer: anchorIssuer,
							amount: "2.0000000",
						},
					],
				}),
			],
		})
		expect(wrongAmount.outcome).toBe("MISMATCH")

		const wrongDestination = reconcileAnchorPayment({
			expectation,
			transactions: [
				horizonTx({
					operations: [
						{
							type: "payment",
							destination: Keypair.random().publicKey(),
							asset_type: "credit_alphanum4",
							asset_code: "USDC",
							asset_issuer: anchorIssuer,
							amount: "1.0000000",
						},
					],
				}),
			],
		})
		expect(wrongDestination.outcome).toBe("MISMATCH")
	})

	it("does not guess when operations are missing or two payments match", () => {
		const noOperations = reconcileAnchorPayment({
			expectation,
			transactions: [horizonTx({ operations: undefined })],
		})
		expect(noOperations.outcome).toBe("NOT_VERIFIED")
		expect(noOperations.reasons.join(" ")).toMatch(/no operations metadata/)

		const noStatus = reconcileAnchorPayment({
			expectation,
			transactions: [horizonTx({ successful: undefined })],
		})
		expect(noStatus.outcome).toBe("NOT_VERIFIED")
		expect(noStatus.reasons.join(" ")).toMatch(
			/does not state whether it succeeded/,
		)

		const ambiguous = reconcileAnchorPayment({
			expectation,
			transactions: [horizonTx(), horizonTx({ hash: "e".repeat(64) })],
		})
		expect(ambiguous.outcome).toBe("AMBIGUOUS")
		expect(ambiguous.hashes).toHaveLength(2)
	})
})

describe("DF7 payment state", () => {
	const signedState = async (
		overrides: Partial<Df7PaymentState> = {},
	): Promise<Df7PaymentState> => {
		const horizon: ClassicPaymentHorizon = {
			loadAccount: async () => new Account(recipient.publicKey(), "1"),
			fetchBaseFee: async () => 100,
			submitTransaction: async (tx: Transaction) => ({
				hash: Buffer.from(tx.hash()).toString("hex"),
			}),
		}
		const built = await buildAndSignClassicPaymentWithMemo({
			networkPassphrase: TESTNET,
			source: recipient,
			expectation,
			timeoutSeconds: 120,
			horizon,
		})
		const encoded = encodeSignedPayment(built, TESTNET)
		const now = "2026-10-25T13:00:00Z"
		return {
			version: 2,
			anchorTransactionId: refs.anchorTransactionId,
			anchorPaymentHash: encoded.txHash,
			status: "prepared",
			expectation,
			networkPassphrase: TESTNET,
			signedTransactionXdr: encoded.signedTransactionXdr,
			timeBounds: encoded.timeBounds,
			startedAt: now,
			updatedAt: now,
			...overrides,
		}
	}

	it("retains the prepared hash and envelope in a 0600 file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-state-"))
		try {
			const prepared = await signedState()
			createDf7PaymentState(prepared, dir)
			const submitted: Df7PaymentState = {
				...prepared,
				status: "submitted",
			}
			const path = updateDf7PaymentState({
				expected: {
					status: "prepared",
					anchorPaymentHash: prepared.anchorPaymentHash,
				},
				next: submitted,
				dir,
			})
			expect(statSync(path).mode & 0o777).toBe(0o600)
			expect(readDf7PaymentState(dir)).toMatchObject({
				status: "submitted",
				anchorPaymentHash: prepared.anchorPaymentHash,
			})
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects a corrupt state instead of treating it as absent", () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-state-"))
		try {
			writeFileSync(join(dir, "payment-state.json"), "{")
			expect(() => readDf7PaymentState(dir)).toThrow(
				/invalid DF7 payment state/,
			)

			writeFileSync(
				join(dir, "payment-state.json"),
				JSON.stringify({ anchorTransactionId: refs.anchorTransactionId }),
			)
			expect(() => readDf7PaymentState(dir)).toThrow(
				/invalid DF7 payment state|unsupported DF7 payment state version/,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
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
	it("reports the stages in order and marks the payment live-gated", () => {
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
			"PLANNED",
		)
		expect(planDf7Stages(false)[0]?.status).toBe("BLOCKED")
	})
})
