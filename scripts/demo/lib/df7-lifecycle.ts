import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Keypair, StrKey } from "@stellar/stellar-sdk"
import {
	ANCHOR_ENV_NAMES,
	ReferenceAnchorClient,
	isSep24Failure,
	isSep24Success,
	loadAnchorEventEnv,
	sanitiseHostedUrl,
	type AnchorEventEnv,
} from "../../../packages/adapter-stellar/src/index.ts"
import { AssertionFailure } from "./assertions.ts"
import type { Blocker } from "./report.ts"

/**
 * DF7 scaffold. This module does not submit transactions or call the anchor.
 * Its job is to make the prerequisites, the stage vocabulary, the three separate
 * references and the success/failure/pending decision explicit before a live run.
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
			"needs the claim path's vault release hash, kept separate from anchor refs",
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
			"NOT_IMPLEMENTED",
			"scaffold stops before the live classic memo payment",
		),
		stage(
			"poll_terminal",
			"PLANNED",
			"getTransaction / waitForTerminal with a bounded timeout",
		),
		stage(
			"classify",
			"PLANNED",
			"SUCCESS only with completed + assertion + all three distinct refs",
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
 * The three references are deliberately different kinds of evidence:
 * an anchor record id, a classic payment hash, and a Soroban release hash.
 * None may stand in for another, and the two hashes must not be the same tx.
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
	if (payment && release && HASH.test(payment) && HASH.test(release)) {
		if (payment.toLowerCase() === release.toLowerCase()) {
			problems.push(
				"anchor payment hash and vault release hash are the same transaction; keep them separate",
			)
		}
	}
	return problems
}

export function assertSeparateDf7Refs(refs: Df7RefsInput): void {
	const problems = df7RefProblems(refs)
	if (problems.length > 0) throw new AssertionFailure(problems.join("; "))
}

export type Df7Outcome = "SUCCESS" | "FAILURE" | "PENDING" | "BLOCKED"
export type Df7Assertion = "pass" | "fail" | "not-run"

export interface Df7ClassificationInput {
	/** SEP-24 status as returned by the anchor, e.g. pending_user_transfer_start. */
	anchorStatus?: string
	refs?: Df7RefsInput
	/** Result of the local amount/destination/memo assertion after payment. */
	withdrawAssertion?: Df7Assertion
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
 *   all present and distinct.
 * A timeout or missing reference is PENDING, not PASS.
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
				outcome: "PENDING",
				reasons: [
					"SEP-24 completed but evidence is incomplete",
					...referenceProblems,
				],
				nextAction:
					"reconcile the three separate refs; do not claim DF7/M1 success yet",
			}
		}
		if (input.withdrawAssertion !== "pass") {
			return {
				outcome: "PENDING",
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
				"SEP-24 completed; local assertion passed; three distinct refs present",
			],
			nextAction:
				"retain the three refs separately; integrated M1 still needs the API/UI claim journey",
		}
	}
	return {
		outcome: "PENDING",
		reasons: [`SEP-24 status ${status} is not terminal`],
		nextAction:
			"poll within the bounded window; a timeout stays PENDING/INCOMPLETE",
	}
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
