import { randomBytes } from "node:crypto"
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs"
import { basename, dirname, join } from "node:path"
import {
	Keypair,
	StrKey,
	Transaction,
	TransactionBuilder,
} from "@stellar/stellar-sdk"
import {
	ANCHOR_ENV_NAMES,
	ReferenceAnchorClient,
	isSep24Failure,
	isSep24Success,
	loadAnchorEventEnv,
	sameAsset,
	sanitiseHostedUrl,
	type AnchorEventEnv,
	type AnchorPaymentExpectation,
	type ClassicPaymentTimeBounds,
	type SignedClassicPayment,
	type StellarAssetIdentity,
} from "../../../packages/adapter-stellar/src/index.ts"
import { AssertionFailure } from "./assertions.ts"
import type { Blocker } from "./report.ts"

/**
 * DF7 scaffold. This module validates, persists and reconciles the classic-payment
 * stage but does not call the anchor or submit a transaction itself. The exact
 * signed envelope is persisted before submit so a crash or timeout can only be
 * recovered from the retained hash.
 */

export const DF7_AMOUNT = "1"

export const DF7_STAGE_IDS = [
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
] as const

export type Df7StageId = (typeof DF7_STAGE_IDS)[number]
export type Df7StageStatus =
	| "READY"
	| "BLOCKED"
	| "PLANNED"
	| "PENDING"
	| "PASS"
	| "FAIL"
	| "NOT_IMPLEMENTED"
	| "NOT_RUN"

export interface Df7StageView {
	id: Df7StageId
	label: string
	status: Df7StageStatus
	detail: string
}

export const DF7_STAGE_LABELS: Record<Df7StageId, string> = {
	prerequisites: "CCR-20 ids, anchor asset, recipient identity",
	vault_release: "Vault release to recipient A (input: distinct hash)",
	discover: "Anchor TOML and listed asset",
	authenticate: "SEP-10 classic session",
	price: "Indicative SEP-38 price",
	start_withdraw: "SEP-24 hosted withdrawal session",
	hosted_interactive: "Human completes hosted withdrawal",
	anchor_payment: "Classic memo payment to anchor (once)",
	poll_terminal: "Bounded poll to terminal anchor status",
	classify: "Classify result and keep three refs separate",
}

/**
 * The scaffold stops before a classic payment. The adapter already exports
 * `submitClassicPaymentWithMemo`; wiring it into an acceptance run is a separate,
 * explicitly approved live step, not part of this reviewable scaffold.
 */
export function planDf7Stages(prerequisitesOk: boolean): Df7StageView[] {
	const stage = (
		id: Df7StageId,
		status: Df7StageStatus,
		detail: string,
	): Df7StageView => ({
		id,
		label: DF7_STAGE_LABELS[id],
		status,
		detail,
	})
	return [
		stage(
			"prerequisites",
			prerequisitesOk ? "READY" : "BLOCKED",
			prerequisitesOk
				? "public ids valid; secret checked only by --preflight"
				: "see blockers above",
		),
		stage(
			"vault_release",
			"NOT_RUN",
			"needs the claim path's vault release hash, kept separate by role",
		),
		stage("discover", "PLANNED", "ReferenceAnchorClient.connect()"),
		stage(
			"authenticate",
			"PLANNED",
			"ReferenceAnchorClient.authenticate(recipient A); JWT stays in memory",
		),
		stage(
			"price",
			"PLANNED",
			"indicative SEP-38 context=sep6; not a binding quote",
		),
		stage(
			"start_withdraw",
			"PLANNED",
			"startWithdrawInteractive(); full URL goes to a 0600 private file",
		),
		stage(
			"hosted_interactive",
			"NOT_RUN",
			"human/browser step; cannot be scripted",
		),
		stage(
			"anchor_payment",
			"PLANNED",
			"build/sign, persist the exact hash/XDR, then submit once; live-gated",
		),
		stage(
			"poll_terminal",
			"PLANNED",
			"getTransaction / waitForTerminal with a bounded timeout",
		),
		stage(
			"classify",
			"PLANNED",
			"SUCCESS only with completed + assertion + verified refs",
		),
	]
}

export function formatDf7Stage(stage: Df7StageView): string {
	return `${stage.id.padEnd(18)} ${stage.status.padEnd(15)} ${stage.detail}`
}

export interface Df7Refs {
	/** SEP-24 anchor transaction id (not a transaction hash). */
	anchorTransactionId: string
	/** Horizon hash of the classic payment carrying the anchor memo. */
	anchorPaymentHash: string
	/** Soroban transaction hash of the vault release/claim. */
	vaultReleaseHash: string
}

export type Df7RefsInput = Partial<Record<keyof Df7Refs, string | undefined>>

const HASH = /^[0-9a-f]{64}$/i

/**
 * The three references are different kinds of evidence: an anchor record id, a
 * classic payment hash, and a Soroban release hash. Their values are not required
 * to differ — a caller must not infer a role from string inequality. Each value is
 * checked against its own source and role by the stage that produced it.
 */
export function df7RefProblems(refs: Df7RefsInput): string[] {
	const problems: string[] = []
	if (!refs.anchorTransactionId?.trim()) {
		problems.push("anchor transaction id is missing (SEP-24 id)")
	}
	const payment = refs.anchorPaymentHash?.trim()
	if (!payment) {
		problems.push("anchor payment hash is missing (classic memo payment)")
	} else if (!HASH.test(payment)) {
		problems.push("anchor payment hash is not a 64-hex transaction hash")
	}
	const release = refs.vaultReleaseHash?.trim()
	if (!release) {
		problems.push("vault release hash is missing (Soroban claim)")
	} else if (!HASH.test(release)) {
		problems.push("vault release hash is not a 64-hex transaction hash")
	}
	return problems
}

export function assertDf7Refs(refs: Df7RefsInput): void {
	const problems = df7RefProblems(refs)
	if (problems.length > 0) throw new AssertionFailure(problems.join("; "))
}

export interface Df7RefProof {
	/** The SEP-24 id was checked against the anchor's transaction record. */
	anchorTransactionIdVerified?: boolean
	/** The classic payment hash was checked against the payment submit or anchor stellar_transaction_id. */
	anchorPaymentHashVerified?: boolean
	/** The claim path verified the hash against the vault release transaction. */
	vaultReleaseHashVerified?: boolean
}

export function df7ProofProblems(proof: Df7RefProof = {}): string[] {
	const problems: string[] = []
	if (!proof.anchorTransactionIdVerified) {
		problems.push(
			"anchor transaction id was not verified against the anchor record",
		)
	}
	if (!proof.anchorPaymentHashVerified) {
		problems.push(
			"anchor payment hash was not verified against the classic payment",
		)
	}
	if (!proof.vaultReleaseHashVerified) {
		problems.push(
			"vault release hash was not verified against the claim release",
		)
	}
	return problems
}

export type Df7Outcome =
	"SUCCESS" | "FAILURE" | "PENDING" | "NOT_VERIFIED" | "BLOCKED"
export type Df7Assertion = "pass" | "fail" | "not-run"

export interface Df7ClassificationInput {
	/** SEP-24 status as returned by the anchor, e.g. pending_user_transfer_start. */
	anchorStatus?: string
	refs?: Df7RefsInput
	/** Verification of each ref against its actual source and role. */
	proof?: Df7RefProof
	/** Result of the local amount/destination/memo assertion after payment. */
	withdrawAssertion?: Df7Assertion
	/** A confirmed anchor-provided amount/asset/destination/memo mismatch. */
	paymentMismatch?: boolean
	/** Non-mismatch payment-field problems (missing/invalid fields). */
	paymentProblems?: string[]
	/** True when the bounded poll expired without a terminal status. */
	timedOut?: boolean
	/** False when a prerequisite check already blocked the run. */
	prerequisitesOk?: boolean
}

export interface Df7Classification {
	outcome: Df7Outcome
	reasons: string[]
	nextAction: string
}

/**
 * Never call `completed` success on its own. M1 PASS needs:
 * - a completed SEP-24 withdrawal,
 * - the local amount/destination/memo assertion to pass,
 * - the anchor transaction id, anchor payment hash and vault release hash,
 *   each present and verified against its own source,
 * - no confirmed payment-field mismatch.
 * A timeout is PENDING; completed with incomplete proof is NOT_VERIFIED.
 */
export function classifyDf7Lifecycle(
	input: Df7ClassificationInput,
): Df7Classification {
	if (input.prerequisitesOk === false) {
		return {
			outcome: "BLOCKED",
			reasons: ["prerequisite checks failed"],
			nextAction: "fix the blockers before any network or transaction step",
		}
	}
	if (input.timedOut) {
		return {
			outcome: "PENDING",
			reasons: [
				"bounded poll expired without a terminal anchor status; INCOMPLETE",
			],
			nextAction:
				"reconcile by anchor transaction id; do not submit a second payment blindly",
		}
	}

	const status = input.anchorStatus?.trim()
	if (!status) {
		return {
			outcome: "PENDING",
			reasons: ["no SEP-24 status supplied"],
			nextAction: "start or poll the anchor transaction",
		}
	}
	if (isSep24Failure(status)) {
		return {
			outcome: "FAILURE",
			reasons: [`SEP-24 status ${status} is terminal and unsuccessful`],
			nextAction: "stop; record the failure; do not submit another payment",
		}
	}
	if (isSep24Success(status)) {
		if (input.paymentMismatch) {
			return {
				outcome: "FAILURE",
				reasons: [
					"SEP-24 completed with a confirmed payment-field or reference mismatch",
				],
				nextAction: "stop; preserve the mismatch; do not relabel it as pending",
			}
		}
		if (input.withdrawAssertion === "fail") {
			return {
				outcome: "FAILURE",
				reasons: [
					"SEP-24 completed but the amount/destination/memo assertion failed",
				],
				nextAction: "stop; do not claim M1 success; preserve the mismatch",
			}
		}
		const referenceProblems = df7RefProblems(input.refs ?? {})
		if (referenceProblems.length > 0) {
			return {
				outcome: "NOT_VERIFIED",
				reasons: [
					"SEP-24 completed but evidence is incomplete",
					...referenceProblems,
				],
				nextAction:
					"reconcile each reference against its actual source; do not claim DF7/M1 success yet",
			}
		}
		const paymentProblems = input.paymentProblems ?? []
		if (paymentProblems.length > 0) {
			return {
				outcome: "NOT_VERIFIED",
				reasons: [
					"SEP-24 completed but the payment evidence is incomplete",
					...paymentProblems,
				],
				nextAction:
					"supply valid anchor asset, amount, destination and memo proof",
			}
		}
		const proofProblems = df7ProofProblems(input.proof)
		if (proofProblems.length > 0) {
			return {
				outcome: "NOT_VERIFIED",
				reasons: [
					"SEP-24 completed but each reference has not been verified at its source",
					...proofProblems,
				],
				nextAction:
					"verify anchor id, payment hash and vault release hash separately",
			}
		}
		if (input.withdrawAssertion !== "pass") {
			return {
				outcome: "NOT_VERIFIED",
				reasons: [
					"SEP-24 completed but the amount/destination/memo assertion was not run",
				],
				nextAction:
					"run assertSuccessfulWithdraw/payment decode before classifying success",
			}
		}
		return {
			outcome: "SUCCESS",
			reasons: [
				"SEP-24 completed; payment assertion passed; refs verified at their sources",
			],
			nextAction:
				"retain the three refs by role; integrated M1 still needs the API/UI claim journey",
		}
	}
	return {
		outcome: "PENDING",
		reasons: [`SEP-24 status ${status} is not terminal`],
		nextAction:
			"poll within the bounded window; a timeout stays PENDING/INCOMPLETE",
	}
}

const DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{1,7})?$/
const MEMO_TYPES = new Set(["id", "text", "hash", "return"])
const STROOPS = /^(\d+)(?:\.(\d{1,7}))?$/

/** Compare decimal amounts without treating "1" and "1.0000000" as different. */
export function decimalEquals(a: string, b: string): boolean {
	if (!DECIMAL.test(a.trim()) || !DECIMAL.test(b.trim())) return false
	const left = toStroops(a)
	const right = toStroops(b)
	return left !== undefined && left === right
}

function toStroops(value: string): bigint | undefined {
	const match = STROOPS.exec(value.trim())
	if (!match) return undefined
	const whole = BigInt(match[1]!)
	const fraction = (match[2] ?? "").padEnd(7, "0")
	return whole * 10_000_000n + BigInt(fraction)
}

const asString = (value: unknown): string | undefined =>
	typeof value === "string" && value.trim() ? value.trim() : undefined

export interface AnchorDeclaredAsset {
	code: string
	issuer: string
}

/**
 * Read the asset the anchor published on a SEP-24 record, when it publishes one.
 * The reference anchor's withdraw record often carries only amount/destination/
 * memo. Absence is recorded as `assetSource: "request"`; it never means an
 * unknown asset was accepted, because the client is constructed with the
 * configured identity.
 */
export function anchorDeclaredAsset(
	raw: Record<string, unknown>,
): AnchorDeclaredAsset | undefined {
	const line = asString(raw.amount_in_asset)
	if (line) {
		const value = line.startsWith("stellar:")
			? line.slice("stellar:".length)
			: line
		if (value === "native" || value === "XLM") {
			return { code: "native", issuer: "" }
		}
		const colon = value.indexOf(":")
		if (colon > 0) {
			return { code: value.slice(0, colon), issuer: value.slice(colon + 1) }
		}
		return { code: value, issuer: "" }
	}
	const code = asString(raw.asset_code)
	if (!code) return undefined
	return { code, issuer: asString(raw.asset_issuer) ?? "" }
}

export type AnchorAssetSource = "anchor-record" | "request"

export interface AnchorPaymentValidation {
	/** Missing or malformed anchor fields: do not submit; evidence is incomplete. */
	problems: string[]
	/** Confirmed amount/asset/destination/memo/reference mismatch: FAIL. */
	mismatches: string[]
	/** Where the validated asset identity came from. */
	assetSource: AnchorAssetSource
}

/**
 * Validate the payment fields the anchor supplied before any classic payment.
 * The submitted hash is retained separately in the payment state file. A
 * confirmed mismatch is FAIL; a missing field is NOT_VERIFIED, never an excuse
 * to submit and poll anyway.
 */
export function validateAnchorPayment(input: {
	status: string
	expectation: AnchorPaymentExpectation
	expectedAsset: StellarAssetIdentity
	expectedAmount?: string
	anchorTransactionId: string
	expectedAnchorTransactionId?: string
	/** Raw SEP-24 record; used only to compare a published asset declaration. */
	anchorRecord?: Record<string, unknown>
}): AnchorPaymentValidation {
	const problems: string[] = []
	const mismatches: string[] = []
	const { expectation } = input
	if (input.status !== "pending_user_transfer_start") {
		problems.push(
			`anchor status ${input.status} is not pending_user_transfer_start; no payment is safe`,
		)
	}
	if (!sameAsset(expectation.asset, input.expectedAsset)) {
		mismatches.push(
			`anchor asset ${expectation.asset.code}:${expectation.asset.issuer} does not match the configured ${input.expectedAsset.code}:${input.expectedAsset.issuer}`,
		)
	}
	let assetSource: AnchorAssetSource = "request"
	const declared = input.anchorRecord
		? anchorDeclaredAsset(input.anchorRecord)
		: undefined
	if (declared) {
		assetSource = "anchor-record"
		const expected = input.expectedAsset
		const sameIdentity =
			declared.code === expected.code &&
			(declared.code === "native" || declared.issuer === expected.issuer)
		if (!sameIdentity) {
			mismatches.push(
				`anchor-published asset ${declared.code}:${declared.issuer || "(no issuer)"} does not match the configured ${expected.code}:${expected.issuer}`,
			)
		}
	}
	const amount = expectation.amount.trim()
	if (!DECIMAL.test(amount) || !/[1-9]/.test(amount)) {
		problems.push(
			`anchor amount ${JSON.stringify(expectation.amount)} is not a positive decimal`,
		)
	}
	if (input.expectedAmount && !decimalEquals(amount, input.expectedAmount)) {
		mismatches.push(
			`anchor amount ${amount} does not match the expected ${input.expectedAmount}`,
		)
	}
	if (!StrKey.isValidEd25519PublicKey(expectation.destination)) {
		problems.push("anchor destination is not a G-address")
	}
	if (!expectation.memo.trim()) {
		problems.push("anchor memo is empty")
	}
	const memoType = (expectation.memoType ?? "text").toLowerCase()
	if (!MEMO_TYPES.has(memoType)) {
		problems.push(`anchor memo type ${memoType} is not supported`)
	}
	if (memoType === "id" && !/^\d+$/.test(expectation.memo)) {
		problems.push("anchor id memo is not a decimal id")
	}
	if (
		(memoType === "hash" || memoType === "return") &&
		!HASH.test(expectation.memo)
	) {
		problems.push(`anchor ${memoType} memo is not 64-hex`)
	}
	if (memoType === "text" && Buffer.byteLength(expectation.memo, "utf8") > 28) {
		problems.push("anchor text memo exceeds 28 bytes")
	}
	if (
		input.expectedAnchorTransactionId &&
		input.anchorTransactionId !== input.expectedAnchorTransactionId
	) {
		mismatches.push(
			`anchor transaction id ${input.anchorTransactionId} does not match ${input.expectedAnchorTransactionId}`,
		)
	}
	return { problems, mismatches, assetSource }
}

export interface AnchorCompletionCheck {
	/** Required anchor evidence is missing: NOT_VERIFIED, not a failure. */
	problems: string[]
	/** Confirmed amount/destination/memo mismatch against the paid fields: FAIL. */
	mismatches: string[]
}

/**
 * Verify a terminal SEP-24 record against the fields that were actually paid.
 * Missing `amount_in`/destination/memo is reported as incomplete, never skipped.
 */
export function verifyAnchorCompletion(input: {
	expectation: AnchorPaymentExpectation
	amountIn?: string
	destination?: string
	memo?: string
	memoType?: string
}): AnchorCompletionCheck {
	const problems: string[] = []
	const mismatches: string[] = []
	const { expectation } = input
	if (!input.amountIn?.trim()) {
		problems.push(
			"anchor did not publish amount_in; amount evidence is incomplete",
		)
	} else if (!decimalEquals(input.amountIn, expectation.amount)) {
		mismatches.push(
			`anchor amount_in ${input.amountIn} does not match the paid ${expectation.amount}`,
		)
	}
	if (!input.destination?.trim()) {
		problems.push(
			"anchor did not publish withdraw_anchor_account; destination evidence is incomplete",
		)
	} else if (input.destination !== expectation.destination) {
		mismatches.push(
			"anchor withdraw_anchor_account does not match the paid destination",
		)
	}
	if (!input.memo?.trim()) {
		problems.push(
			"anchor did not publish withdraw_memo; memo evidence is incomplete",
		)
	} else if (input.memo !== expectation.memo) {
		mismatches.push("anchor withdraw_memo does not match the paid memo")
	}
	const expectedType = (expectation.memoType ?? "text").toLowerCase()
	if (!input.memoType?.trim()) {
		problems.push(
			"anchor did not publish withdraw_memo_type; memo type evidence is incomplete",
		)
	} else if (input.memoType.trim().toLowerCase() !== expectedType) {
		mismatches.push(
			`anchor memo type ${input.memoType.trim().toLowerCase()} does not match the paid ${expectedType}`,
		)
	}
	return { problems, mismatches }
}

export type Df7PaymentStateStatus =
	"prepared" | "submitted" | "reconciled" | "uncertain"

/**
 * The retained pre-submit state. It is written before the signed payment is sent,
 * so a crash or a lost submit response can only be recovered from these bytes.
 * The signed envelope is sensitive: never log or commit this file's contents.
 */
export interface Df7PaymentState {
	version: 2
	anchorTransactionId: string
	/** Hash of the signed envelope, known before submission. */
	anchorPaymentHash: string
	status: Df7PaymentStateStatus
	expectation: AnchorPaymentExpectation
	networkPassphrase: string
	/** Lossless base64 envelope XDR of the exact signed transaction. */
	signedTransactionXdr: string
	timeBounds: ClassicPaymentTimeBounds
	startedAt: string
	updatedAt: string
	/** Set when a bounded Horizon reconciliation confirmed the stored hash. */
	reconciledAt?: string
}

export class Df7PreSubmitError extends Error {
	readonly stage: "window" | "restore" | "persist" | "verify"

	constructor(
		stage: "window" | "restore" | "persist" | "verify",
		message: string,
	) {
		super(message)
		this.name = "Df7PreSubmitError"
		this.stage = stage
	}
}

export function df7PaymentStatePath(
	dir = process.env.FP_DF7_PRIVATE_DIR?.trim() || "/tmp/fp-df7-private",
): string {
	return join(dir, "payment-state.json")
}

const HASH_HEX = /^[0-9a-f]{64}$/

function finiteBounds(bounds: ClassicPaymentTimeBounds): boolean {
	return (
		Number.isFinite(bounds.minTime) &&
		Number.isFinite(bounds.maxTime) &&
		bounds.maxTime > bounds.minTime
	)
}

/**
 * Serialise the signed envelope and prove the exact bytes restore to the same
 * network hash before the caller can persist or submit them.
 */
export function encodeSignedPayment(
	signed: SignedClassicPayment,
	networkPassphrase: string,
): {
	txHash: string
	timeBounds: ClassicPaymentTimeBounds
	signedTransactionXdr: string
} {
	if (!networkPassphrase.trim()) {
		throw new Df7PreSubmitError("restore", "network passphrase is required")
	}
	if (!finiteBounds(signed.timeBounds)) {
		throw new Df7PreSubmitError(
			"restore",
			"signed payment has missing or inverted time bounds",
		)
	}
	const txHash = Buffer.from(signed.signedTx.hash()).toString("hex")
	if (!HASH_HEX.test(txHash) || txHash !== signed.txHash) {
		throw new Df7PreSubmitError(
			"restore",
			"signed transaction hash does not match the builder's pre-submit hash",
		)
	}
	const signedTransactionXdr = signed.signedTx.toEnvelope().toXDR("base64")
	let restored: Transaction | unknown
	try {
		restored = TransactionBuilder.fromXDR(
			signedTransactionXdr,
			networkPassphrase,
		)
	} catch {
		throw new Df7PreSubmitError(
			"restore",
			"signed transaction XDR could not be restored",
		)
	}
	if (!(restored instanceof Transaction)) {
		throw new Df7PreSubmitError(
			"restore",
			"signed transaction restored as a fee-bump envelope, not a payment",
		)
	}
	if (Buffer.from(restored.hash()).toString("hex") !== txHash) {
		throw new Df7PreSubmitError(
			"restore",
			"restored transaction hash differs from the pre-submit hash",
		)
	}
	const restoredBounds = restored.timeBounds
	if (
		!restoredBounds ||
		Number(restoredBounds.minTime) !== signed.timeBounds.minTime ||
		Number(restoredBounds.maxTime) !== signed.timeBounds.maxTime
	) {
		throw new Df7PreSubmitError(
			"restore",
			"restored transaction time bounds differ from the signed time bounds",
		)
	}
	return { txHash, timeBounds: signed.timeBounds, signedTransactionXdr }
}

/**
 * Restore the exact stored envelope and re-check its hash and time bounds. This
 * never re-signs and never rebuilds the payment.
 */
export function restoreSignedPayment(state: Df7PaymentState): Transaction {
	if (!HASH_HEX.test(state.anchorPaymentHash)) {
		throw new Df7PreSubmitError("restore", "stored payment hash is not 64 hex")
	}
	if (!finiteBounds(state.timeBounds)) {
		throw new Df7PreSubmitError("restore", "stored time bounds are invalid")
	}
	let restored: Transaction | unknown
	try {
		restored = TransactionBuilder.fromXDR(
			state.signedTransactionXdr,
			state.networkPassphrase,
		)
	} catch {
		throw new Df7PreSubmitError(
			"restore",
			"stored signed transaction cannot be restored",
		)
	}
	if (!(restored instanceof Transaction)) {
		throw new Df7PreSubmitError(
			"restore",
			"stored envelope is not a classic transaction",
		)
	}
	if (
		Buffer.from(restored.hash()).toString("hex") !== state.anchorPaymentHash
	) {
		throw new Df7PreSubmitError(
			"restore",
			"restored transaction hash does not match the retained payment hash",
		)
	}
	const restoredBounds = restored.timeBounds
	if (
		!restoredBounds ||
		Number(restoredBounds.minTime) !== state.timeBounds.minTime ||
		Number(restoredBounds.maxTime) !== state.timeBounds.maxTime
	) {
		throw new Df7PreSubmitError(
			"restore",
			"restored time bounds do not match the retained time bounds",
		)
	}
	return restored
}

/** Read the private submission state. It contains no secret key. */
export function readDf7PaymentState(dir?: string): Df7PaymentState | undefined {
	const path = df7PaymentStatePath(dir)
	if (!existsSync(path)) return undefined
	let parsed: unknown
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"))
	} catch {
		throw new Error(`invalid DF7 payment state at ${path}`)
	}
	const invalid = (): never => {
		throw new Error(`invalid DF7 payment state at ${path}`)
	}
	if (typeof parsed !== "object" || parsed === null) invalid()
	const state = parsed as Partial<Df7PaymentState>
	if (state.version !== 2) {
		throw new Error(
			`unsupported DF7 payment state version at ${path}; inspect and resolve manually`,
		)
	}
	if (
		typeof state.anchorTransactionId !== "string" ||
		typeof state.anchorPaymentHash !== "string" ||
		!HASH_HEX.test(state.anchorPaymentHash) ||
		typeof state.expectation !== "object" ||
		state.expectation === null ||
		typeof state.networkPassphrase !== "string" ||
		!state.networkPassphrase.trim() ||
		typeof state.signedTransactionXdr !== "string" ||
		!state.signedTransactionXdr ||
		typeof state.timeBounds !== "object" ||
		state.timeBounds === null ||
		!Number.isFinite(state.timeBounds.minTime) ||
		!Number.isFinite(state.timeBounds.maxTime) ||
		state.timeBounds.maxTime <= state.timeBounds.minTime ||
		!["prepared", "submitted", "reconciled", "uncertain"].includes(
			state.status ?? "",
		)
	) {
		invalid()
	}
	return state as Df7PaymentState
}

/**
 * Atomic private write: same-directory temp file, fsync, rename, 0600. A failure
 * leaves the previous state intact and must block any submission.
 */
function writePrivateState(path: string, contents: string): void {
	const dir = dirname(path)
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	chmodSync(dir, 0o700)
	const temp = join(
		dir,
		`.${basename(path)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
	)
	const fd = openSync(temp, "wx", 0o600)
	try {
		writeSync(fd, contents)
		fsyncSync(fd)
	} catch (error) {
		try {
			closeSync(fd)
		} catch {
			/* the original write error is the useful one */
		}
		try {
			unlinkSync(temp)
		} catch {
			/* best-effort cleanup of the private temp file */
		}
		throw error
	}
	closeSync(fd)
	try {
		renameSync(temp, path)
		chmodSync(path, 0o600)
	} catch (error) {
		try {
			unlinkSync(temp)
		} catch {
			/* best-effort cleanup */
		}
		throw error
	}
}

/** Persist the signed payment state atomically before any submission. */
export function saveDf7PaymentState(
	state: Df7PaymentState,
	dir = process.env.FP_DF7_PRIVATE_DIR?.trim() || "/tmp/fp-df7-private",
): string {
	const path = df7PaymentStatePath(dir)
	writePrivateState(path, JSON.stringify(state, null, 2))
	return path
}

/**
 * Persist first, verify the persisted envelope restores to the same hash, then
 * submit. A persistence/restore failure throws before the submit callback runs.
 */
export async function persistPreparedThenSubmit(input: {
	state: Df7PaymentState
	submit: (
		tx: Transaction,
		persisted: Df7PaymentState,
	) => Promise<{ txHash: string }>
	dir?: string
	persist?: (state: Df7PaymentState, dir?: string) => string
	nowSec?: number
}): Promise<{ path: string; submittedHash: string }> {
	if (input.state.status !== "prepared") {
		throw new Df7PreSubmitError(
			"persist",
			`payment state must be prepared before submit, got ${input.state.status}`,
		)
	}
	const window = checkRebroadcastWindow(input.state, input.nowSec)
	if (!window.ok) throw new Df7PreSubmitError("window", window.detail)
	try {
		restoreSignedPayment(input.state)
	} catch (error) {
		throw new Df7PreSubmitError(
			"restore",
			error instanceof Error ? error.message : String(error),
		)
	}

	let path: string
	try {
		path = (input.persist ?? saveDf7PaymentState)(input.state, input.dir)
	} catch (error) {
		throw new Df7PreSubmitError(
			"persist",
			`could not persist the signed payment: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	let persisted: Df7PaymentState | undefined
	try {
		persisted = readDf7PaymentState(input.dir)
	} catch (error) {
		throw new Df7PreSubmitError(
			"persist",
			`persisted payment state cannot be read back: ${error instanceof Error ? error.message : String(error)}`,
		)
	}
	if (!persisted) {
		throw new Df7PreSubmitError(
			"persist",
			"persisted payment state is missing after the write",
		)
	}
	let restored: Transaction
	try {
		restored = restoreSignedPayment(persisted)
	} catch (error) {
		throw new Df7PreSubmitError(
			"restore",
			error instanceof Error ? error.message : String(error),
		)
	}

	const submitted = await input.submit(restored, persisted)
	if (submitted.txHash !== persisted.anchorPaymentHash) {
		throw new Df7PreSubmitError(
			"verify",
			`submitted hash ${submitted.txHash} differs from the retained hash ${persisted.anchorPaymentHash}`,
		)
	}
	return { path, submittedHash: submitted.txHash }
}

export type Df7RebroadcastWindow =
	| { ok: true }
	| {
			ok: false
			reason: "expired" | "not-yet-valid" | "invalid"
			detail: string
	  }

/** The stored envelope may only be rebroadcast inside its own time bounds. */
export function checkRebroadcastWindow(
	state: Df7PaymentState,
	nowSec = Math.floor(Date.now() / 1000),
): Df7RebroadcastWindow {
	if (!finiteBounds(state.timeBounds)) {
		return {
			ok: false,
			reason: "invalid",
			detail: "stored time bounds are missing or inverted",
		}
	}
	if (nowSec < state.timeBounds.minTime) {
		return {
			ok: false,
			reason: "not-yet-valid",
			detail: `signed payment is not valid before ${new Date(state.timeBounds.minTime * 1000).toISOString()}`,
		}
	}
	if (nowSec > state.timeBounds.maxTime) {
		return {
			ok: false,
			reason: "expired",
			detail: `signed payment expired at ${new Date(state.timeBounds.maxTime * 1000).toISOString()}`,
		}
	}
	return { ok: true }
}

/**
 * Explicit rebroadcast authorisation: the operator must echo the retained hash,
 * the state must not already be confirmed, and the signed envelope must still be
 * inside its time bounds. Nothing here sends a transaction.
 */
export function checkDf7RebroadcastGates(input: {
	state: Df7PaymentState
	confirm?: string
	nowSec?: number
}): { blockers: string[] } {
	const blockers: string[] = []
	if (input.confirm?.trim() !== input.state.anchorPaymentHash) {
		blockers.push(
			"FP_DF7_REBROADCAST_CONFIRM must equal the retained payment hash",
		)
	}
	if (input.state.status !== "prepared" && input.state.status !== "uncertain") {
		blockers.push(
			`payment state ${input.state.status} is not eligible for rebroadcast; reconcile it first`,
		)
	}
	const window = checkRebroadcastWindow(input.state, input.nowSec)
	if (!window.ok) blockers.push(window.detail)
	return { blockers }
}

export interface Df7GateInput {
	FP_DF7_ALLOW_NETWORK?: string
	FP_DF7_SUBMIT_PAYMENT?: string
	FP_DF7_RECIPIENT_LOCK?: string
}

export interface Df7GateResult {
	blockers: string[]
	lock?: string
}

/**
 * Live-execution gates for the classic payment. All three are required: network,
 * explicit submit approval, and the recipient-A transaction window claimed via
 * `scripts/testnet/EVENT-TX-WINDOWS.md`.
 */
export function checkDf7PaymentGates(input: Df7GateInput = {}): Df7GateResult {
	const blockers: string[] = []
	if (input.FP_DF7_ALLOW_NETWORK !== "1") {
		blockers.push("FP_DF7_ALLOW_NETWORK=1 is required for a network step")
	}
	if (input.FP_DF7_SUBMIT_PAYMENT !== "1") {
		blockers.push("FP_DF7_SUBMIT_PAYMENT=1 is required for a classic payment")
	}
	const lock = input.FP_DF7_RECIPIENT_LOCK?.trim()
	if (!lock) {
		blockers.push(
			"FP_DF7_RECIPIENT_LOCK is required: supply the LOCK recipient A <agent> DF7 <UTC> confirmation",
		)
	} else if (
		!/^LOCK\s+recipient\s*a\b/i.test(lock) ||
		!/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(lock)
	) {
		blockers.push(
			"FP_DF7_RECIPIENT_LOCK is not a recipient-A LOCK confirmation with a UTC start",
		)
	}
	return { blockers, ...(lock ? { lock } : {}) }
}

export interface HorizonPaymentOperation {
	type?: string
	destination?: string
	asset_type?: string
	asset_code?: string
	asset_issuer?: string
	amount?: string
}

export interface HorizonTransactionRecord {
	hash?: string
	successful?: boolean
	memo?: string
	memo_type?: string
	created_at?: string
	operations?: HorizonPaymentOperation[]
}

export type Df7ReconcileOutcome =
	| "RECONCILED"
	| "NOT_FOUND"
	| "MISMATCH"
	| "FAILED"
	| "AMBIGUOUS"
	| "NOT_VERIFIED"

export interface Df7ReconcileResult {
	outcome: Df7ReconcileOutcome
	/** The recovered payment hash; empty unless RECONCILED. */
	hashes: string[]
	/** How many recent transactions were inspected. */
	inspected: number
	reasons: string[]
}

/**
 * Reconcile the exact hash retained before submission. No lookup alternative is
 * accepted: a different memo-carrying payment is not the transaction this run
 * signed. NOT_FOUND never authorises a resend.
 */
export function reconcileStoredHash(input: {
	storedHash: string
	expectation: AnchorPaymentExpectation
	transaction?: HorizonTransactionRecord
}): Df7ReconcileResult {
	const { storedHash, expectation, transaction } = input
	if (!HASH_HEX.test(storedHash)) {
		return {
			outcome: "NOT_VERIFIED",
			hashes: [],
			inspected: 0,
			reasons: ["retained payment hash is not 64 hex"],
		}
	}
	if (!transaction) {
		return {
			outcome: "NOT_FOUND",
			hashes: [],
			inspected: 0,
			reasons: [
				"Horizon has no transaction with the retained payment hash",
				"do not resend on NOT_FOUND; an authorised rebroadcast or a new payment needs a human decision",
			],
		}
	}
	if (transaction.hash !== storedHash) {
		return {
			outcome: "MISMATCH",
			hashes: [],
			inspected: 1,
			reasons: ["Horizon record hash does not match the retained payment hash"],
		}
	}
	if (typeof transaction.successful !== "boolean") {
		return {
			outcome: "NOT_VERIFIED",
			hashes: [],
			inspected: 1,
			reasons: ["the retained transaction does not state whether it succeeded"],
		}
	}
	if (!transaction.successful) {
		return {
			outcome: "FAILED",
			hashes: [],
			inspected: 1,
			reasons: [
				"the retained transaction is on-chain but failed; do not rebroadcast it",
			],
		}
	}
	const memoType = (expectation.memoType ?? "text").toLowerCase()
	if (typeof transaction.memo !== "string") {
		return {
			outcome: "NOT_VERIFIED",
			hashes: [],
			inspected: 1,
			reasons: ["the retained transaction has no memo in the Horizon record"],
		}
	}
	if (transaction.memo !== expectation.memo) {
		return {
			outcome: "MISMATCH",
			hashes: [],
			inspected: 1,
			reasons: [
				"the retained transaction memo differs from the anchor instruction",
			],
		}
	}
	if (typeof transaction.memo_type !== "string") {
		return {
			outcome: "NOT_VERIFIED",
			hashes: [],
			inspected: 1,
			reasons: ["the retained transaction does not publish a memo type"],
		}
	}
	if (transaction.memo_type.toLowerCase() !== memoType) {
		return {
			outcome: "MISMATCH",
			hashes: [],
			inspected: 1,
			reasons: [
				`the retained transaction memo type ${transaction.memo_type} differs from the anchor instruction ${memoType}`,
			],
		}
	}
	if (!Array.isArray(transaction.operations)) {
		return {
			outcome: "NOT_VERIFIED",
			hashes: [],
			inspected: 1,
			reasons: ["the retained transaction has no operations metadata"],
		}
	}
	const payments = transaction.operations.filter((op) => op?.type === "payment")
	if (payments.length !== 1) {
		return {
			outcome: "MISMATCH",
			hashes: [],
			inspected: 1,
			reasons: [
				`the retained transaction has ${payments.length} payment operations, expected exactly one`,
			],
		}
	}
	if (!paymentMatches(payments[0]!, expectation)) {
		return {
			outcome: "MISMATCH",
			hashes: [],
			inspected: 1,
			reasons: [
				"the retained transaction's payment destination, amount or asset differs from the anchor instruction",
			],
		}
	}
	return {
		outcome: "RECONCILED",
		hashes: [storedHash],
		inspected: 1,
		reasons: [
			`retained classic payment ${storedHash} matches the anchor destination, amount, asset and memo`,
		],
	}
}

/**
 * Match a bounded page of the recipient's Horizon transactions to the retained
 * payment intent. Memo is the anchor instruction, so a memo-carrying transaction
 * whose payment operation differs is a confirmed mismatch, not "not found".
 * Unrelated transactions are ignored. A page without a match is NOT_FOUND, which
 * still forbids a blind retry.
 */
export function reconcileAnchorPayment(input: {
	expectation: AnchorPaymentExpectation
	transactions: readonly HorizonTransactionRecord[]
}): Df7ReconcileResult {
	const memo = input.expectation.memo
	const memoType = (input.expectation.memoType ?? "text").toLowerCase()
	const candidates = input.transactions.filter(
		(tx) =>
			tx.memo === memo && (tx.memo_type ?? "text").toLowerCase() === memoType,
	)
	const matches: string[] = []
	const mismatches: string[] = []
	const incomplete: string[] = []
	const failed: string[] = []
	const seen = new Set<string>()
	for (const tx of candidates) {
		const hash = tx.hash?.trim() ?? ""
		if (!HASH.test(hash)) {
			incomplete.push("a memo-matching transaction has no 64-hex hash")
			continue
		}
		if (seen.has(hash)) continue
		seen.add(hash)
		if (typeof tx.successful !== "boolean") {
			incomplete.push(
				`memo-matching transaction ${hash} does not state whether it succeeded`,
			)
			continue
		}
		if (!tx.successful) {
			failed.push(hash)
			continue
		}
		if (!Array.isArray(tx.operations)) {
			incomplete.push(
				`memo-matching transaction ${hash} has no operations metadata`,
			)
			continue
		}
		const payments = tx.operations.filter((op) => op?.type === "payment")
		if (payments.some((op) => paymentMatches(op, input.expectation))) {
			matches.push(hash)
		} else if (payments.length > 0) {
			mismatches.push(
				`memo-matching transaction ${hash}: payment destination/amount/asset does not match the anchor instruction`,
			)
		} else {
			mismatches.push(
				`memo-matching transaction ${hash} has no payment operation`,
			)
		}
	}

	const inspected = input.transactions.length
	if (
		matches.length === 1 &&
		mismatches.length === 0 &&
		incomplete.length === 0
	) {
		return {
			outcome: "RECONCILED",
			hashes: matches,
			inspected,
			reasons: [
				`memo-carrying classic payment ${matches[0]} matches the retained destination, amount and asset`,
			],
		}
	}
	if (
		matches.length > 1 ||
		(matches.length === 1 && (mismatches.length > 0 || incomplete.length > 0))
	) {
		return {
			outcome: "AMBIGUOUS",
			hashes: matches,
			inspected,
			reasons: [
				`${matches.length} matching memo-carrying payments and ${mismatches.length + incomplete.length} conflicting records`,
				"stop; do not send another payment",
			],
		}
	}
	if (mismatches.length > 0) {
		return {
			outcome: "MISMATCH",
			hashes: [],
			inspected,
			reasons: mismatches,
		}
	}
	if (incomplete.length > 0) {
		return {
			outcome: "NOT_VERIFIED",
			hashes: [],
			inspected,
			reasons: incomplete,
		}
	}
	return {
		outcome: "NOT_FOUND",
		hashes: [],
		inspected,
		reasons: [
			failed.length > 0
				? `memo-carrying transaction(s) ${failed.join(", ")} failed on-chain; no successful payment found`
				: `no successful memo-carrying payment in ${inspected} recent transactions`,
			"absence in a bounded page is not proof of no submission; do not retry blindly",
		],
	}
}

function paymentMatches(
	op: HorizonPaymentOperation,
	expectation: AnchorPaymentExpectation,
): boolean {
	if (op.destination !== expectation.destination) return false
	if (typeof op.amount !== "string") return false
	if (!decimalEquals(op.amount, expectation.amount)) return false
	const asset = expectation.asset
	if (asset.code === "native") return op.asset_type === "native"
	return (
		op.asset_type !== "native" &&
		op.asset_code === asset.code &&
		op.asset_issuer === asset.issuer
	)
}

export interface Df7PrereqInput {
	publicEnv: Record<string, string | undefined>
	baselineEnv: Record<string, string | undefined>
	secretEnv?: Record<string, string | undefined>
	/** Check the recipient secret and its public address. */
	requireSecret?: boolean
}

export interface Df7PrereqResult {
	blockers: Blocker[]
	env?: AnchorEventEnv
	recipient?: Keypair
}

const owner = "Freebuff (DF7 scaffold)"

const value = (
	env: Record<string, string | undefined>,
	key: string,
): string | undefined => env[key]?.trim() || undefined

const contract = (address: string): boolean => StrKey.isValidContract(address)
const account = (address: string): boolean =>
	StrKey.isValidEd25519PublicKey(address)

/**
 * Local-only prerequisites. It never calls the anchor and never reads on-chain
 * config, so its PASS is "scaffold ready", not "anchor lifecycle verified".
 */
export function checkDf7Prerequisites(input: Df7PrereqInput): Df7PrereqResult {
	const blockers: Blocker[] = []
	const publicEnv = input.publicEnv
	const baseline = input.baselineEnv

	const required = [
		ANCHOR_ENV_NAMES.homeDomain,
		ANCHOR_ENV_NAMES.networkPassphrase,
		ANCHOR_ENV_NAMES.usdcAsset,
		ANCHOR_ENV_NAMES.usdcContractId,
		ANCHOR_ENV_NAMES.anchorVaultId,
		ANCHOR_ENV_NAMES.anchorVaultFeeBps,
		ANCHOR_ENV_NAMES.anchorVaultTreasury,
		ANCHOR_ENV_NAMES.anchorVaultPurpose,
	] as const
	for (const key of required) {
		if (!value(publicEnv, key)) {
			blockers.push({
				what: `${key} is missing from the anchor public ids`,
				owner,
				detail:
					"consume Cursor's testnet-ids-anchor-vault.env; do not create a competing file",
			})
		}
	}

	for (const key of [
		"FP_PAYOUT_VAULT_ID",
		"FP_USDC_ASSET",
		"FP_USDC_CONTRACT_ID",
		"FP_STELLAR_NETWORK_PASSPHRASE",
	] as const) {
		if (!value(baseline, key)) {
			blockers.push({
				what: `${key} is missing from the baseline ids`,
				owner,
				detail: "DF7 compares against the baseline ids without replacing them",
			})
		}
	}

	const anchorVaultId = value(publicEnv, ANCHOR_ENV_NAMES.anchorVaultId)
	const baselineVaultId = value(baseline, "FP_PAYOUT_VAULT_ID")
	if (anchorVaultId && !contract(anchorVaultId)) {
		blockers.push({
			what: `${ANCHOR_ENV_NAMES.anchorVaultId} is not a Stellar contract address`,
			owner,
		})
	}
	if (anchorVaultId && baselineVaultId && anchorVaultId === baselineVaultId) {
		blockers.push({
			what: "anchor vault id equals the baseline payout vault id",
			owner,
			detail:
				"DF7 must use the isolated anchor vault, never the baseline vault",
		})
	}

	const anchorAssetLine = value(publicEnv, ANCHOR_ENV_NAMES.usdcAsset)
	const baselineAssetLine = value(baseline, "FP_USDC_ASSET")
	if (
		anchorAssetLine &&
		baselineAssetLine &&
		anchorAssetLine === baselineAssetLine
	) {
		blockers.push({
			what: "anchor USDC asset equals the baseline vault USDC asset",
			owner,
			detail:
				"the reference anchor uses GBBD47…, not the baseline GBBO6N… asset",
		})
	}

	const contractId = value(publicEnv, ANCHOR_ENV_NAMES.usdcContractId)
	if (contractId && !contract(contractId)) {
		blockers.push({
			what: `${ANCHOR_ENV_NAMES.usdcContractId} is not a Stellar contract address`,
			owner,
		})
	}
	const baselineContractId = value(baseline, "FP_USDC_CONTRACT_ID")
	if (contractId && baselineContractId && contractId === baselineContractId) {
		blockers.push({
			what: "anchor USDC contract id equals the baseline USDC contract id",
			owner,
		})
	}

	const passphrase = value(publicEnv, ANCHOR_ENV_NAMES.networkPassphrase)
	const baselinePassphrase = value(baseline, "FP_STELLAR_NETWORK_PASSPHRASE")
	if (passphrase && baselinePassphrase && passphrase !== baselinePassphrase) {
		blockers.push({
			what: "anchor network passphrase differs from the baseline network",
			owner,
		})
	}

	const treasury = value(publicEnv, ANCHOR_ENV_NAMES.anchorVaultTreasury)
	if (treasury && !account(treasury)) {
		blockers.push({
			what: `${ANCHOR_ENV_NAMES.anchorVaultTreasury} is not a G-address`,
			owner,
		})
	}

	const feeRaw = value(publicEnv, ANCHOR_ENV_NAMES.anchorVaultFeeBps)
	if (feeRaw) {
		const fee = Number(feeRaw)
		if (!Number.isInteger(fee) || fee < 0 || fee > 1000) {
			blockers.push({
				what: `${ANCHOR_ENV_NAMES.anchorVaultFeeBps} is outside 0..1000`,
				owner,
			})
		}
	}

	const purpose = value(publicEnv, ANCHOR_ENV_NAMES.anchorVaultPurpose)
	if (purpose && !/reference-anchor/i.test(purpose)) {
		blockers.push({
			what: `${ANCHOR_ENV_NAMES.anchorVaultPurpose} does not identify the reference-anchor vault`,
			owner,
		})
	}

	let env: AnchorEventEnv | undefined
	if (blockers.length === 0) {
		try {
			env = loadAnchorEventEnv(publicEnv)
		} catch (error) {
			blockers.push({
				what: error instanceof Error ? error.message : String(error),
				owner,
				detail: "public anchor ids are invalid",
			})
		}
	}

	let recipient: Keypair | undefined
	if (input.requireSecret) {
		const secret = value(input.secretEnv ?? {}, "FP_RECIPIENT_A_SECRET")
		const address = value(publicEnv, "FP_RECIPIENT_A_ADDRESS")
		if (!secret) {
			blockers.push({
				what: "FP_RECIPIENT_A_SECRET is missing",
				owner: "caller / Freebuff live run",
				detail: "load the git-ignored .env.secrets-anchor-vault overlay",
			})
		}
		if (!address) {
			blockers.push({
				what: "FP_RECIPIENT_A_ADDRESS is missing",
				owner,
				detail: "public recipient address must match the secret",
			})
		}
		if (secret && address) {
			try {
				const keypair = Keypair.fromSecret(secret)
				if (keypair.publicKey() !== address) {
					blockers.push({
						what: "FP_RECIPIENT_A_SECRET does not match FP_RECIPIENT_A_ADDRESS",
						owner,
						detail: "the secret value was not logged",
					})
				} else {
					recipient = keypair
				}
			} catch {
				blockers.push({
					what: "FP_RECIPIENT_A_SECRET is not a valid Stellar secret",
					owner,
					detail: "the secret value was not logged",
				})
			}
		}
	}

	return {
		blockers,
		...(env ? { env } : {}),
		...(recipient ? { recipient } : {}),
	}
}

export function createDf7AnchorClient(
	env: AnchorEventEnv,
): ReferenceAnchorClient {
	return new ReferenceAnchorClient({
		homeDomain: env.homeDomain,
		networkPassphrase: env.networkPassphrase,
		asset: env.asset,
	})
}

export interface HostedUrlFile {
	/** Full URL, 0600, for the human/browser only. Never put this path's content in evidence. */
	path: string
	/** Origin + pathname only, safe for logs and evidence. */
	urlSanitised: string
}

/**
 * Writes the functional hosted URL for browser navigation and returns only the
 * sanitised form for logs. The file is owner-readable and lives outside the repo.
 */
export function saveHostedUrlForBrowser(
	url: string,
	dir = process.env.FP_DF7_PRIVATE_DIR?.trim() || "/tmp/fp-df7-private",
): HostedUrlFile {
	const parsed = new URL(url)
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error("hosted URL must be http(s)")
	}
	mkdirSync(dir, { recursive: true, mode: 0o700 })
	chmodSync(dir, 0o700)
	const path = join(dir, "hosted-withdraw-url.txt")
	writeFileSync(path, url, { mode: 0o600 })
	chmodSync(path, 0o600)
	return { path, urlSanitised: sanitiseHostedUrl(url) }
}

export function parseDf7Amount(raw: string): string {
	const amount = raw.trim()
	if (!/^(?:[1-9](?:\.\d{1,7})?|10(?:\.0{1,7})?)$/.test(amount)) {
		throw new Error(
			`amount must be a decimal from 1 to 10 with at most 7 decimals, got ${JSON.stringify(raw)}`,
		)
	}
	return amount
}
