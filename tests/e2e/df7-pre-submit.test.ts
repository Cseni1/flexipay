import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Account, Keypair, type Transaction } from "@stellar/stellar-sdk"
import { describe, expect, it, vi } from "vitest"
import {
	buildAndSignClassicPaymentWithMemo,
	type AnchorPaymentExpectation,
	type ClassicPaymentHorizon,
} from "../../packages/adapter-stellar/src/index.ts"
import {
	Df7PreSubmitError,
	checkDf7RebroadcastGates,
	checkRebroadcastWindow,
	encodeSignedPayment,
	persistPreparedThenSubmit,
	readDf7PaymentState,
	reconcileStoredHash,
	restoreSignedPayment,
	saveDf7PaymentState,
	type Df7PaymentState,
} from "../../scripts/demo/lib/df7-lifecycle.ts"

// Offline only: the Horizon surface is a stub, and no transaction is submitted.

const NET = "Test SDF Network ; September 2015"
const issuer = Keypair.random().publicKey()
const source = Keypair.random()
const destination = Keypair.random().publicKey()

const expectation: AnchorPaymentExpectation = {
	asset: { code: "USDC", issuer, networkPassphrase: NET },
	amount: "1",
	destination,
	memo: "2304272553721027745",
	memoType: "id",
}

function stubHorizon(): ClassicPaymentHorizon {
	return {
		loadAccount: async () => new Account(source.publicKey(), "1"),
		fetchBaseFee: async () => 100,
		submitTransaction: async (tx: Transaction) => ({
			hash: Buffer.from(tx.hash()).toString("hex"),
		}),
	}
}

async function preparedState(
	timeoutSeconds = 120,
	overrides: Partial<Df7PaymentState> = {},
): Promise<Df7PaymentState> {
	const built = await buildAndSignClassicPaymentWithMemo({
		networkPassphrase: NET,
		source,
		expectation,
		timeoutSeconds,
		horizon: stubHorizon(),
	})
	const encoded = encodeSignedPayment(built, NET)
	const now = new Date().toISOString()
	return {
		version: 2,
		anchorTransactionId: "sep24-anchor-id-1",
		anchorPaymentHash: encoded.txHash,
		status: "prepared",
		expectation,
		networkPassphrase: NET,
		signedTransactionXdr: encoded.signedTransactionXdr,
		timeBounds: encoded.timeBounds,
		startedAt: now,
		updatedAt: now,
		...overrides,
	}
}

function matchingRecord(state: Df7PaymentState) {
	return {
		hash: state.anchorPaymentHash,
		successful: true,
		memo: expectation.memo,
		memo_type: "id",
		operations: [
			{
				type: "payment",
				destination,
				asset_type: "credit_alphanum4",
				asset_code: "USDC",
				asset_issuer: issuer,
				amount: "1.0000000",
			},
		],
	}
}

describe("DF7 pre-submit persistence", () => {
	it("writes the exact hash, XDR, network, bounds and expectation as 0600", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-presubmit-"))
		try {
			const state = await preparedState()
			const path = saveDf7PaymentState(state, dir)
			const raw = JSON.parse(readFileSync(path, "utf8")) as Df7PaymentState

			expect(raw).toMatchObject({
				version: 2,
				anchorTransactionId: state.anchorTransactionId,
				anchorPaymentHash: state.anchorPaymentHash,
				status: "prepared",
				networkPassphrase: NET,
				timeBounds: state.timeBounds,
				expectation,
			})
			expect(raw.signedTransactionXdr).toBe(state.signedTransactionXdr)
			expect(statSync(path).mode & 0o777).toBe(0o600)
			expect(statSync(dir).mode & 0o777).toBe(0o700)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("does not submit when persistence fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-fail-"))
		try {
			const state = await preparedState()
			const fileAsDir = join(dir, "not-a-directory")
			writeFileSync(fileAsDir, "x")
			const submit = vi.fn(async () => ({ txHash: state.anchorPaymentHash }))

			await expect(
				persistPreparedThenSubmit({ state, dir: fileAsDir, submit }),
			).rejects.toMatchObject({ stage: "persist" })
			expect(submit).not.toHaveBeenCalled()

			await expect(
				persistPreparedThenSubmit({
					state,
					dir,
					persist: () => {
						throw new Error("disk full")
					},
					submit,
				}),
			).rejects.toBeInstanceOf(Df7PreSubmitError)
			expect(submit).not.toHaveBeenCalled()
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("restores the persisted envelope to the same hash and bytes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-restore-"))
		try {
			const state = await preparedState()
			saveDf7PaymentState(state, dir)
			const persisted = readDf7PaymentState(dir)!
			const restored = restoreSignedPayment(persisted)

			expect(Buffer.from(restored.hash()).toString("hex")).toBe(
				state.anchorPaymentHash,
			)
			expect(restored.toEnvelope().toXDR("base64")).toBe(
				state.signedTransactionXdr,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("refuses a legacy state that has no signed envelope", () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-legacy-"))
		try {
			writeFileSync(
				join(dir, "payment-state.json"),
				JSON.stringify({
					version: 1,
					anchorTransactionId: "sep24-anchor-id-1",
					anchorPaymentHash: null,
					status: "submitting",
					expectation,
				}),
			)
			expect(() => readDf7PaymentState(dir)).toThrow(
				/unsupported DF7 payment state version/,
			)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("rejects a mutated hash or envelope instead of submitting it", async () => {
		const state = await preparedState()
		expect(() =>
			restoreSignedPayment({ ...state, anchorPaymentHash: "f".repeat(64) }),
		).toThrow(/hash/)

		const corrupted = {
			...state,
			signedTransactionXdr: `${state.signedTransactionXdr.slice(0, -8)}AAAA`,
		}
		expect(() => restoreSignedPayment(corrupted)).toThrow(/restore|restored/)
	})

	it("blocks an expired envelope and never invokes submit", async () => {
		const state = await preparedState()
		const after = state.timeBounds.maxTime + 1

		expect(checkRebroadcastWindow(state, after)).toMatchObject({
			ok: false,
			reason: "expired",
		})
		expect(
			checkDf7RebroadcastGates({
				state,
				confirm: state.anchorPaymentHash,
				nowSec: after,
			}).blockers.join(" "),
		).toMatch(/expired/)

		const submit = vi.fn(async () => ({ txHash: state.anchorPaymentHash }))
		await expect(
			persistPreparedThenSubmit({ state, nowSec: after, submit }),
		).rejects.toMatchObject({ stage: "window" })
		expect(submit).not.toHaveBeenCalled()
	})

	it("survives a submit timeout and recovers only by the retained hash", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fp-df7-crash-"))
		try {
			const state = await preparedState()
			const submit = vi.fn(async () => {
				throw new Error("Horizon timeout after send")
			})

			await expect(
				persistPreparedThenSubmit({ state, dir, submit }),
			).rejects.toThrow(/timeout/)
			expect(submit).toHaveBeenCalledTimes(1)

			const persisted = readDf7PaymentState(dir)!
			expect(persisted.status).toBe("prepared")
			expect(persisted.anchorPaymentHash).toBe(state.anchorPaymentHash)
			expect(persisted.signedTransactionXdr).toBe(state.signedTransactionXdr)

			const confirmed = reconcileStoredHash({
				storedHash: persisted.anchorPaymentHash,
				expectation,
				transaction: matchingRecord(persisted),
			})
			expect(confirmed.outcome).toBe("RECONCILED")
			expect(confirmed.hashes).toEqual([state.anchorPaymentHash])

			const missing = reconcileStoredHash({
				storedHash: persisted.anchorPaymentHash,
				expectation,
				transaction: undefined,
			})
			expect(missing.outcome).toBe("NOT_FOUND")
			expect(missing.reasons.join(" ")).toMatch(/do not resend/)
			expect(submit).toHaveBeenCalledTimes(1)
		} finally {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	it("requires an explicit hash confirmation and an unsettled state", async () => {
		const state = await preparedState()
		expect(checkDf7RebroadcastGates({ state }).blockers.join(" ")).toMatch(
			/FP_DF7_REBROADCAST_CONFIRM/,
		)
		expect(
			checkDf7RebroadcastGates({
				state,
				confirm: "a".repeat(64),
			}).blockers.join(" "),
		).toMatch(/FP_DF7_REBROADCAST_CONFIRM/)

		expect(
			checkDf7RebroadcastGates({
				state: { ...state, status: "submitted" },
				confirm: state.anchorPaymentHash,
			}).blockers.join(" "),
		).toMatch(/not eligible/)
	})

	it("classifies a failed on-chain transaction as FAILED, not NOT_FOUND", async () => {
		const state = await preparedState()
		const result = reconcileStoredHash({
			storedHash: state.anchorPaymentHash,
			expectation,
			transaction: {
				...matchingRecord(state),
				successful: false,
				operations: undefined,
			},
		})
		expect(result.outcome).toBe("FAILED")
		expect(result.reasons.join(" ")).toMatch(/do not rebroadcast/)
	})
})
