/**
 * DF7 — reference-anchor lifecycle scaffold (Stellar testnet).
 *
 * This script is deliberately a scaffold, not a DF7 acceptance run. It:
 * - loads Cursor's `testnet-ids-anchor-vault.env` and the CCR-20 names;
 * - checks local prerequisites and the recipient secret/public-key match;
 * - reports the lifecycle stages and classifies success/failure/pending;
 * - can perform read-only anchor readiness/polling and start a hosted session
 *   behind network gates;
 * - can submit the classic memo payment exactly once behind network + submit +
 *   recipient-window gates, retaining the hash before any polling;
 * - reconciles an uncertain submission against bounded Horizon reads without a
 *   second submit.
 *
 * The full hosted URL is for browser navigation only. It is written to a 0600
 * private file; logs and evidence receive the sanitised origin+pathname.
 *
 * No API/UI contracts are assumed. Live DF7 needs the claim path's vault release
 * hash and an approved classic-payment step; see the evidence file.
 */
import { existsSync, readFileSync } from "node:fs"
import { relative, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import {
	AnchorClientError,
	parseEnvFile,
	submitClassicPaymentWithMemo,
	type AnchorPaymentExpectation,
} from "../../packages/adapter-stellar/src/index.ts"
import {
	DF7_AMOUNT,
	checkDf7PaymentGates,
	checkDf7Prerequisites,
	classifyDf7Lifecycle,
	createDf7AnchorClient,
	df7PaymentStatePath,
	formatDf7Stage,
	parseDf7Amount,
	planDf7Stages,
	readDf7PaymentState,
	reconcileAnchorPayment,
	saveDf7PaymentState,
	saveHostedUrlForBrowser,
	validateAnchorPayment,
	verifyAnchorCompletion,
	type Df7Assertion,
	type Df7PaymentState,
	type Df7RefsInput,
	type HorizonPaymentOperation,
	type HorizonTransactionRecord,
} from "./lib/df7-lifecycle.ts"
import { maskAddress } from "./lib/env.ts"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const baselineIdsPath = resolve(repoRoot, "scripts/testnet/testnet-ids.env")
const anchorIdsPath = resolve(
	repoRoot,
	"scripts/testnet/testnet-ids-anchor-vault.env",
)
const anchorSecretsPath = resolve(
	repoRoot,
	"scripts/testnet/.env.secrets-anchor-vault",
)

const argv = process.argv.slice(2)
const has = (flag: string): boolean => argv.includes(`--${flag}`)
const option = (name: string): string | undefined => {
	const inline = argv.find((arg) => arg.startsWith(`--${name}=`))
	if (inline) return inline.slice(`--${name}=`.length)
	const index = argv.indexOf(`--${name}`)
	return index >= 0 ? argv[index + 1] : undefined
}

const line = (label: string, text: string): void => {
	console.log(`${label.padEnd(12)}${text}`)
}
const section = (text: string): void => {
	console.log(`\n${text}`)
}

function readEnvFile(path: string): Record<string, string> {
	if (!existsSync(path)) return {}
	return parseEnvFile(readFileSync(path, "utf8"))
}

function parseAssertion(raw: string | undefined): Df7Assertion {
	if (raw === undefined || raw === "not-run") return "not-run"
	if (raw === "pass" || raw === "fail") return raw
	throw new Error(`--withdraw-check must be pass, fail or not-run, got ${raw}`)
}

function parseTimeout(raw: string | undefined): number {
	const value = Number(raw ?? 180_000)
	if (!Number.isFinite(value) || value < 5_000 || value > 600_000) {
		throw new Error("--timeout-ms must be between 5000 and 600000")
	}
	return value
}

function refsFromArgs(): Df7RefsInput {
	return {
		anchorTransactionId: option("anchor-tx-id"),
		anchorPaymentHash: option("anchor-payment-hash"),
		vaultReleaseHash: option("vault-release-hash"),
	}
}

function printRefs(refs: Df7RefsInput): void {
	line("ref-anchor", refs.anchorTransactionId?.trim() || "(missing)")
	line("ref-payment", refs.anchorPaymentHash?.trim() || "(missing)")
	line("ref-release", refs.vaultReleaseHash?.trim() || "(missing)")
}

const OUTCOME_EXIT = {
	SUCCESS: 0,
	FAILURE: 1,
	PENDING: 2,
	NOT_VERIFIED: 2,
	BLOCKED: 2,
} as const

function printBlockers(
	blockers: ReadonlyArray<{ what: string; owner: string; detail?: string }>,
): void {
	for (const blocker of blockers) {
		line("blocked", `${blocker.what}  [owner: ${blocker.owner}]`)
		if (blocker.detail) line("", `detail: ${blocker.detail}`)
	}
}

function loadPublicEnv(): {
	publicEnv: Record<string, string>
	baselineEnv: Record<string, string>
	secretEnv: Record<string, string>
} {
	return {
		publicEnv: readEnvFile(anchorIdsPath),
		baselineEnv: readEnvFile(baselineIdsPath),
		secretEnv: readEnvFile(anchorSecretsPath),
	}
}

function printStagePlan(prerequisitesOk: boolean): void {
	section("Lifecycle stages")
	for (const stage of planDf7Stages(prerequisitesOk)) {
		console.log(`  ${formatDf7Stage(stage)}`)
	}
}

function planMode(): never {
	const { publicEnv, baselineEnv } = loadPublicEnv()
	line("scaffold", "DF7 anchor lifecycle — NO NETWORK, NO TRANSACTION")
	line("ids", `anchor ${relative(repoRoot, anchorIdsPath)}`)
	line(
		"ids",
		`baseline ${relative(repoRoot, baselineIdsPath)} (comparison only)`,
	)
	const pre = checkDf7Prerequisites({
		publicEnv,
		baselineEnv,
		requireSecret: false,
	})
	printBlockers(pre.blockers)
	printStagePlan(pre.blockers.length === 0)
	line(
		"note",
		"preflight checks the recipient secret; readiness/poll/start are network-gated.",
	)
	line(
		"note",
		"anchor_payment is implemented but live-gated; this plan mode never submits.",
	)
	line("result", pre.blockers.length === 0 ? "SCAFFOLD_READY" : "BLOCKED")
	process.exit(pre.blockers.length === 0 ? 0 : 2)
}

function preflight(requireSecret: boolean): {
	publicEnv: Record<string, string>
	baselineEnv: Record<string, string>
	pre: ReturnType<typeof checkDf7Prerequisites>
} {
	const { publicEnv, baselineEnv, secretEnv } = loadPublicEnv()
	const pre = checkDf7Prerequisites({
		publicEnv,
		baselineEnv,
		secretEnv,
		requireSecret,
	})
	return { publicEnv, baselineEnv, pre }
}

function printPreflightSummary(
	pre: ReturnType<typeof checkDf7Prerequisites>,
): void {
	if (!pre.env) return
	line("anchor", `vault ${pre.env.anchorVaultId ?? "(missing)"}`)
	line("anchor", `home ${pre.env.homeDomain}`)
	line(
		"asset",
		`${pre.env.asset.code}:${pre.env.asset.issuer}  SAC ${pre.env.asset.contractId ?? "(missing)"}`,
	)
	line(
		"fee",
		`${pre.env.anchorVaultFeeBps ?? "(missing)"} bps (configured, not on-chain checked)`,
	)
	if (pre.recipient) {
		line(
			"recipient",
			`${maskAddress(pre.recipient.publicKey())} (secret matches)`,
		)
	}
}

function preflightMode(): never {
	const { pre } = preflight(true)
	line("scaffold", "DF7 local preflight — NO NETWORK, NO TRANSACTION")
	printBlockers(pre.blockers)
	printPreflightSummary(pre)
	line("note", "on-chain vault config and anchor TOML are not checked here")
	line("result", pre.blockers.length === 0 ? "PREFLIGHT_PASS" : "BLOCKED")
	process.exit(pre.blockers.length === 0 ? 0 : 2)
}

function requireNetworkGate(): void {
	if (process.env.FP_DF7_ALLOW_NETWORK !== "1") {
		line("blocked", "FP_DF7_ALLOW_NETWORK=1 is required for a network step")
		line("result", "BLOCKED")
		process.exit(2)
	}
}

function requirePaymentGate(): string {
	const gates = checkDf7PaymentGates(process.env)
	if (gates.blockers.length > 0) {
		for (const blocker of gates.blockers) line("blocked", blocker)
		line("result", "BLOCKED")
		process.exit(2)
	}
	return gates.lock!
}

const HORIZON =
	process.env.FP_STELLAR_HORIZON_URL?.trim() ||
	"https://horizon-testnet.stellar.org"

async function horizonJson(url: string): Promise<Record<string, unknown>> {
	const res = await fetch(url, {
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	})
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
	if (!res.ok) {
		throw new Error(`Horizon ${res.status} for ${new URL(url).pathname}`)
	}
	return body
}

function embeddedRecords(body: Record<string, unknown>): unknown[] {
	const embedded = body._embedded as { records?: unknown } | undefined
	if (!Array.isArray(embedded?.records)) {
		throw new Error("Horizon response has no _embedded.records")
	}
	return embedded.records
}

/**
 * Bounded reconciliation read: the latest `limit` transactions for the recipient,
 * with operations fetched only for memo-carrying records (at most 5). Read-only;
 * no signature and no submit.
 */
async function fetchRecentTransactions(
	account: string,
	memo: string,
	memoType: string,
	limit = 20,
): Promise<HorizonTransactionRecord[]> {
	const base = HORIZON.replace(/\/+$/, "")
	const list = await horizonJson(
		`${base}/accounts/${encodeURIComponent(account)}/transactions?order=desc&limit=${limit}`,
	)
	const rows: HorizonTransactionRecord[] = []
	let opFetches = 0
	for (const raw of embeddedRecords(list).slice(0, limit)) {
		if (typeof raw !== "object" || raw === null) continue
		const tx = raw as Record<string, unknown>
		const row: HorizonTransactionRecord = {
			hash: typeof tx.hash === "string" ? tx.hash : undefined,
			successful:
				typeof tx.successful === "boolean" ? tx.successful : undefined,
			memo: typeof tx.memo === "string" ? tx.memo : undefined,
			memo_type: typeof tx.memo_type === "string" ? tx.memo_type : undefined,
			created_at: typeof tx.created_at === "string" ? tx.created_at : undefined,
		}
		const candidate =
			row.hash &&
			row.memo === memo &&
			(row.memo_type ?? "text").toLowerCase() === memoType
		if (candidate && opFetches < 5) {
			opFetches += 1
			const ops = await horizonJson(
				`${base}/transactions/${row.hash}/operations?order=asc&limit=20`,
			)
			row.operations = embeddedRecords(ops).flatMap((op) => {
				if (typeof op !== "object" || op === null) return []
				const value = op as Record<string, unknown>
				const out: HorizonPaymentOperation = {
					type: typeof value.type === "string" ? value.type : undefined,
					destination:
						typeof value.destination === "string"
							? value.destination
							: undefined,
					asset_type:
						typeof value.asset_type === "string" ? value.asset_type : undefined,
					asset_code:
						typeof value.asset_code === "string" ? value.asset_code : undefined,
					asset_issuer:
						typeof value.asset_issuer === "string"
							? value.asset_issuer
							: undefined,
					amount: typeof value.amount === "string" ? value.amount : undefined,
				}
				return [out]
			})
		}
		rows.push(row)
	}
	return rows
}

function proofFromArgs(): {
	anchorTransactionIdVerified: boolean
	anchorPaymentHashVerified: boolean
	vaultReleaseHashVerified: boolean
} {
	return {
		anchorTransactionIdVerified: has("anchor-tx-verified"),
		anchorPaymentHashVerified: has("payment-verified"),
		vaultReleaseHashVerified: has("vault-release-verified"),
	}
}

function refsAndHashFromState(
	state: Df7PaymentState | undefined,
): Df7RefsInput {
	return {
		anchorTransactionId: option("anchor-tx-id") ?? state?.anchorTransactionId,
		anchorPaymentHash:
			option("anchor-payment-hash") ?? state?.anchorPaymentHash ?? undefined,
		vaultReleaseHash: option("vault-release-hash"),
	}
}

async function readinessMode(): Promise<never> {
	requireNetworkGate()
	const amount = parseDf7Amount(option("amount") ?? DF7_AMOUNT)
	const { pre } = preflight(true)
	printBlockers(pre.blockers)
	if (pre.blockers.length > 0 || !pre.env || !pre.recipient) {
		line("result", "BLOCKED")
		process.exit(2)
	}

	const client = createDf7AnchorClient(pre.env)
	const failed = (error: unknown): never => {
		const code = error instanceof AnchorClientError ? error.code : "unexpected"
		line(
			"error",
			`${code}: ${error instanceof Error ? error.message : String(error)}`,
		)
		line("result", "FAILURE")
		process.exit(1)
	}

	try {
		const endpoints = await client.connect()
		line("discover", `TOML ${pre.env.homeDomain} network matches`)
		line("discover", `SEP-24 ${endpoints.transferServerSep24}`)
		line("discover", `SEP-38 ${endpoints.anchorQuoteServer}`)
		await client.authenticate(pre.recipient)
		line(
			"auth",
			`SEP-10 session established for ${maskAddress(pre.recipient.publicKey())}`,
		)
		line("auth", "JWT kept in memory; not printed")
		const price = await client.indicativeWithdrawPrice({ sellAmount: amount })
		line(
			"price",
			`indicative (${price.context}) ${price.sellAmount} ${pre.env.asset.code} → ${price.buyAmount} USD`,
		)
		line(
			"price",
			"not a binding quote; the hosted screen shows the binding rate",
		)
		line(
			"result",
			"READINESS_PASS (no anchor transaction, no Stellar transaction)",
		)
		process.exit(0)
	} catch (error) {
		return failed(error)
	}
}

async function startWithdrawMode(): Promise<never> {
	requireNetworkGate()
	if (process.env.FP_DF7_START_WITHDRAW !== "1") {
		line(
			"blocked",
			"FP_DF7_START_WITHDRAW=1 is required to create an anchor session",
		)
		line("result", "BLOCKED")
		process.exit(2)
	}
	const amount = parseDf7Amount(option("amount") ?? DF7_AMOUNT)
	const { pre } = preflight(true)
	printBlockers(pre.blockers)
	if (pre.blockers.length > 0 || !pre.env || !pre.recipient) {
		line("result", "BLOCKED")
		process.exit(2)
	}

	const client = createDf7AnchorClient(pre.env)
	try {
		await client.connect()
		await client.authenticate(pre.recipient)
		const session = await client.startWithdrawInteractive({ amount })
		const hosted = saveHostedUrlForBrowser(session.url)
		line("withdraw", `anchor transaction id ${session.id}`)
		line("withdraw", `kind ${session.kind}`)
		line("withdraw", `sanitised URL ${hosted.urlSanitised}`)
		line("withdraw", `full URL file ${hosted.path} (0600; browser only)`)
		line(
			"pending",
			"human must complete the hosted withdrawal; no classic payment was submitted",
		)
		line("result", "PENDING")
		process.exit(2)
	} catch (error) {
		const code = error instanceof AnchorClientError ? error.code : "unexpected"
		line(
			"error",
			`${code}: ${error instanceof Error ? error.message : String(error)}`,
		)
		line("result", "FAILURE")
		process.exit(1)
	}
}

async function payMode(): Promise<never> {
	const window = requirePaymentGate()
	const id = option("id")?.trim()
	if (!id) {
		line("blocked", "--id <SEP-24 anchor transaction id> is required")
		line("result", "BLOCKED")
		process.exit(2)
	}
	const expectedAmount = option("amount")
		? parseDf7Amount(option("amount")!)
		: undefined
	let existing: Df7PaymentState | undefined
	try {
		existing = readDf7PaymentState()
	} catch (error) {
		line("blocked", error instanceof Error ? error.message : String(error))
		line("result", "BLOCKED")
		process.exit(2)
	}
	if (existing) {
		line(
			"blocked",
			`existing payment state ${df7PaymentStatePath()} status=${existing.status} hash=${existing.anchorPaymentHash ?? "(none)"}`,
		)
		line(
			"note",
			"run --reconcile to recover or confirm the hash; this script never submits a second payment",
		)
		line("result", "BLOCKED")
		process.exit(2)
	}

	const { pre } = preflight(true)
	printBlockers(pre.blockers)
	if (pre.blockers.length > 0 || !pre.env || !pre.recipient) {
		line("result", "BLOCKED")
		process.exit(2)
	}

	const client = createDf7AnchorClient(pre.env)
	try {
		await client.connect()
		await client.authenticate(pre.recipient)
		line("window", `recipient A lock supplied: ${window}`)
		line("window", "operator must still release the lock after the run")
		const tx = await client.getTransaction(id)
		line("anchor", `status ${tx.status}`)
		if (tx.status !== "pending_user_transfer_start") {
			printRefs({
				anchorTransactionId: id,
				anchorPaymentHash: option("anchor-payment-hash"),
				vaultReleaseHash: option("vault-release-hash"),
			})
			const classification = classifyDf7Lifecycle({
				anchorStatus: tx.status,
				refs: {
					anchorTransactionId: id,
					anchorPaymentHash: option("anchor-payment-hash"),
					vaultReleaseHash: option("vault-release-hash"),
				},
				proof: proofFromArgs(),
				withdrawAssertion: "not-run",
			})
			line("result", classification.outcome)
			for (const reason of classification.reasons) line("reason", reason)
			line("next", "no payment submitted")
			process.exit(OUTCOME_EXIT[classification.outcome])
		}

		let expectation: AnchorPaymentExpectation
		try {
			expectation = client.paymentExpectationFromTx(tx)
		} catch (error) {
			line(
				"payment",
				`anchor fields incomplete: ${error instanceof Error ? error.message : String(error)}`,
			)
			line("result", "NOT_VERIFIED")
			process.exit(2)
		}

		const validation = validateAnchorPayment({
			status: tx.status,
			expectation,
			expectedAsset: pre.env.asset,
			expectedAmount,
			anchorTransactionId: tx.id,
			expectedAnchorTransactionId: id,
			anchorRecord: tx.raw,
		})
		if (validation.mismatches.length > 0) {
			for (const mismatch of validation.mismatches) line("mismatch", mismatch)
			line("result", "FAILURE")
			line("next", "stop; do not submit a payment for mismatched anchor fields")
			process.exit(1)
		}
		if (validation.problems.length > 0) {
			for (const problem of validation.problems) line("problem", problem)
			line("result", "NOT_VERIFIED")
			line("next", "reconcile the anchor fields; no payment submitted")
			process.exit(2)
		}
		line(
			"payment",
			`${expectation.amount} ${expectation.asset.code}:${expectation.asset.issuer} → ${expectation.destination}`,
		)
		line(
			"payment",
			`memo present type=${(expectation.memoType ?? "text").toLowerCase()} value-length=${expectation.memo.length}`,
		)
		line(
			"asset-source",
			validation.assetSource === "anchor-record"
				? "anchor-published asset matched the configured identity"
				: "anchor record published no asset; validated the requested session asset",
		)

		const startedAt = new Date().toISOString()
		const intent: Df7PaymentState = {
			version: 1,
			anchorTransactionId: tx.id,
			anchorPaymentHash: null,
			status: "submitting",
			expectation,
			startedAt,
			updatedAt: startedAt,
		}
		try {
			saveDf7PaymentState(intent)
		} catch (error) {
			line(
				"error",
				`could not retain pre-submit intent: ${error instanceof Error ? error.message : String(error)}`,
			)
			line("result", "BLOCKED")
			line("next", "fix the private state path before submitting")
			process.exit(2)
		}
		line("state", `intent saved ${df7PaymentStatePath()}`)

		let submitted: { txHash: string }
		try {
			submitted = await submitClassicPaymentWithMemo({
				source: pre.recipient,
				expectation,
				networkPassphrase: pre.env.networkPassphrase,
			})
		} catch (error) {
			const uncertain: Df7PaymentState = {
				...intent,
				status: "uncertain",
				updatedAt: new Date().toISOString(),
			}
			try {
				saveDf7PaymentState(uncertain)
			} catch {
				/* the uncertain state must not hide the original error */
			}
			line(
				"error",
				`classic payment outcome uncertain: ${error instanceof Error ? error.message : String(error)}`,
			)
			line(
				"uncertain",
				`DO NOT RETRY. Run --reconcile for ${tx.id} before any new submit.`,
			)
			line("result", "PENDING")
			process.exit(2)
		}

		const submittedState: Df7PaymentState = {
			...intent,
			status: "submitted",
			anchorPaymentHash: submitted.txHash,
			updatedAt: new Date().toISOString(),
		}
		try {
			saveDf7PaymentState(submittedState)
		} catch (error) {
			line(
				"error",
				`submitted hash ${submitted.txHash} could not be persisted: ${error instanceof Error ? error.message : String(error)}`,
			)
			line("result", "BLOCKED")
			line("next", "do not poll or resubmit until the hash is retained")
			process.exit(2)
		}
		line("payment", `hash ${submitted.txHash}`)
		line("state", "hash retained before any polling")
		line("result", "PENDING")
		line(
			"next",
			`run --poll --id ${id}; do not submit again. If the anchor shows no payment, run --reconcile first.`,
		)
		process.exit(2)
	} catch (error) {
		const code = error instanceof AnchorClientError ? error.code : "unexpected"
		line(
			"error",
			`${code}: ${error instanceof Error ? error.message : String(error)}`,
		)
		line("result", "FAILURE")
		process.exit(1)
	}
}

async function pollMode(): Promise<never> {
	requireNetworkGate()
	const id = option("id")?.trim()
	if (!id) {
		line("blocked", "--id <SEP-24 anchor transaction id> is required")
		line("result", "BLOCKED")
		process.exit(2)
	}
	const timeoutMs = parseTimeout(option("timeout-ms"))
	const assertion = parseAssertion(option("withdraw-check"))
	const { pre } = preflight(true)
	printBlockers(pre.blockers)
	if (pre.blockers.length > 0 || !pre.env || !pre.recipient) {
		line("result", "BLOCKED")
		process.exit(2)
	}
	let state: Df7PaymentState | undefined
	try {
		state = readDf7PaymentState()
	} catch (error) {
		line("blocked", error instanceof Error ? error.message : String(error))
		line("result", "BLOCKED")
		process.exit(2)
	}

	const client = createDf7AnchorClient(pre.env)
	try {
		await client.connect()
		await client.authenticate(pre.recipient)
		const tx = await client.waitForTerminal(id, {
			timeoutMs,
			intervalMs: 5_000,
		})
		line("poll", `status ${tx.status}`)
		line("poll", `amount_in ${tx.amountIn ?? "(missing)"}`)
		line(
			"poll",
			`anchor payment ${tx.stellarTransactionId ?? "(not published)"}`,
		)
		const fromState = refsAndHashFromState(state)
		const refs: Df7RefsInput = {
			...fromState,
			anchorTransactionId: fromState.anchorTransactionId ?? id,
		}
		printRefs(refs)

		const paymentProblems: string[] = []
		let paymentMismatch = false
		let withdrawAssertion = assertion
		if (state?.expectation) {
			const check = verifyAnchorCompletion({
				expectation: state.expectation,
				amountIn: tx.amountIn,
				destination: tx.withdrawAnchorAccount,
				memo: tx.withdrawMemo,
				memoType: tx.withdrawMemoType,
			})
			for (const problem of check.problems) line("problem", problem)
			for (const mismatch of check.mismatches) line("mismatch", mismatch)
			paymentProblems.push(...check.problems)
			paymentMismatch = check.mismatches.length > 0
			withdrawAssertion =
				check.mismatches.length > 0
					? "fail"
					: check.problems.length > 0
						? "not-run"
						: "pass"
		} else if (tx.status === "completed") {
			paymentProblems.push(
				"no retained classic-payment expectation; amount/destination/memo cannot be verified",
			)
		}
		if (
			refs.anchorPaymentHash &&
			tx.stellarTransactionId &&
			tx.stellarTransactionId !== refs.anchorPaymentHash
		) {
			line(
				"mismatch",
				`anchor stellar_transaction_id ${tx.stellarTransactionId} does not match the retained payment hash ${refs.anchorPaymentHash}`,
			)
			paymentMismatch = true
		}
		const classification = classifyDf7Lifecycle({
			anchorStatus: tx.status,
			refs,
			proof: {
				anchorTransactionIdVerified: tx.id === id,
				anchorPaymentHashVerified:
					Boolean(refs.anchorPaymentHash) &&
					tx.stellarTransactionId === refs.anchorPaymentHash,
				vaultReleaseHashVerified: has("vault-release-verified"),
			},
			withdrawAssertion,
			paymentMismatch,
			paymentProblems,
		})
		line("result", classification.outcome)
		for (const reason of classification.reasons) line("reason", reason)
		line("next", classification.nextAction)
		process.exit(OUTCOME_EXIT[classification.outcome])
	} catch (error) {
		const timedOut =
			error instanceof AnchorClientError && error.code === "sep24_timeout"
		const classification = classifyDf7Lifecycle({
			anchorStatus: undefined,
			refs: refsAndHashFromState(state),
			proof: {
				anchorTransactionIdVerified: false,
				anchorPaymentHashVerified: false,
				vaultReleaseHashVerified: false,
			},
			withdrawAssertion: "not-run",
			timedOut,
		})
		line(
			"error",
			error instanceof AnchorClientError
				? `${error.code}: ${error.message}`
				: String(error),
		)
		line("result", classification.outcome)
		for (const reason of classification.reasons) line("reason", reason)
		line("next", classification.nextAction)
		process.exit(OUTCOME_EXIT[classification.outcome])
	}
}

async function reconcileMode(): Promise<never> {
	requireNetworkGate()
	const { publicEnv, pre } = preflight(false)
	printBlockers(pre.blockers)
	if (pre.blockers.length > 0 || !pre.env) {
		line("result", "BLOCKED")
		process.exit(2)
	}
	const address = publicEnv.FP_RECIPIENT_A_ADDRESS?.trim()
	if (!address) {
		line("blocked", "FP_RECIPIENT_A_ADDRESS is missing from the anchor ids")
		line("result", "BLOCKED")
		process.exit(2)
	}
	let state: Df7PaymentState | undefined
	try {
		state = readDf7PaymentState()
	} catch (error) {
		line("blocked", error instanceof Error ? error.message : String(error))
		line("result", "BLOCKED")
		process.exit(2)
	}
	if (!state) {
		line("blocked", `no retained payment state at ${df7PaymentStatePath()}`)
		line("result", "BLOCKED")
		process.exit(2)
	}
	line(
		"state",
		`${df7PaymentStatePath()} status=${state.status} hash=${state.anchorPaymentHash ?? "(none)"}`,
	)
	line("horizon", HORIZON)
	line(
		"note",
		"read-only reconciliation; no signature, no submit, no second payment",
	)

	const memoType = (state.expectation.memoType ?? "text").toLowerCase()
	let transactions: HorizonTransactionRecord[]
	try {
		transactions = await fetchRecentTransactions(
			address,
			state.expectation.memo,
			memoType,
		)
	} catch (error) {
		line("error", error instanceof Error ? error.message : String(error))
		line("result", "NOT_VERIFIED")
		line("next", "fix the Horizon read before any retry decision")
		process.exit(2)
	}

	const result = reconcileAnchorPayment({
		expectation: state.expectation,
		transactions,
	})
	line(
		"scan",
		`${result.inspected} recent transactions; operations read only for memo matches`,
	)
	for (const reason of result.reasons) line("reason", reason)

	if (result.outcome === "RECONCILED") {
		const hash = result.hashes[0]!
		const now = new Date().toISOString()
		try {
			saveDf7PaymentState({
				...state,
				status: "reconciled",
				anchorPaymentHash: hash,
				reconciledAt: now,
				updatedAt: now,
			})
		} catch (error) {
			line("error", error instanceof Error ? error.message : String(error))
			line("result", "BLOCKED")
			line("next", "do not poll or retry until the recovered hash is retained")
			process.exit(2)
		}
		line("payment", `hash ${hash} recovered from Horizon and retained`)
		line("result", "RECONCILED")
		line(
			"next",
			`run --poll --id ${state.anchorTransactionId}; do not submit again`,
		)
		process.exit(2)
	}

	line("result", result.outcome)
	line(
		"next",
		result.outcome === "MISMATCH" || result.outcome === "AMBIGUOUS"
			? "stop; preserve the mismatch; do not send another payment"
			: "no payment submitted; re-check after the next ledger before any retry decision",
	)
	process.exit(
		result.outcome === "MISMATCH" || result.outcome === "AMBIGUOUS" ? 1 : 2,
	)
}

function classifyMode(): never {
	const status = option("anchor-status")
	if (!status) {
		line("blocked", "--anchor-status is required for offline classification")
		line("result", "BLOCKED")
		process.exit(2)
	}
	const classification = classifyDf7Lifecycle({
		anchorStatus: status,
		refs: refsFromArgs(),
		withdrawAssertion: parseAssertion(option("withdraw-check")),
		timedOut: has("timed-out"),
	})
	line("status", status)
	printRefs(refsFromArgs())
	line("class", classification.outcome)
	line(
		"note",
		"offline decision only: refs/assertion are inputs, not executed proof",
	)
	for (const reason of classification.reasons) line("reason", reason)
	line("next", classification.nextAction)
	process.exit(OUTCOME_EXIT[classification.outcome])
}

async function main(): Promise<void> {
	const modes = [
		"preflight",
		"readiness",
		"start-withdraw",
		"pay",
		"reconcile",
		"poll",
		"classify",
	].filter(has)
	if (has("help")) {
		console.log(`DF7 scaffold

  node scripts/demo/df7-anchor-lifecycle.ts
      plan + public-id checks; no network
  node scripts/demo/df7-anchor-lifecycle.ts --preflight
      also check the recipient secret/public key match; no network
  FP_DF7_ALLOW_NETWORK=1 node scripts/demo/df7-anchor-lifecycle.ts --readiness
      TOML + SEP-10 + indicative price; no anchor/Stellar transaction
  FP_DF7_ALLOW_NETWORK=1 FP_DF7_START_WITHDRAW=1 node scripts/demo/df7-anchor-lifecycle.ts --start-withdraw
      create a hosted withdrawal session; stops before payment; full URL goes to a 0600 file
  FP_DF7_ALLOW_NETWORK=1 node scripts/demo/df7-anchor-lifecycle.ts --poll --id <sep24-id>
      bounded read-only status poll; reconciles the retained payment hash
  FP_DF7_ALLOW_NETWORK=1 FP_DF7_SUBMIT_PAYMENT=1 \\
      FP_DF7_RECIPIENT_LOCK="LOCK recipient A <agent> DF7 <UTC>" \\
      node scripts/demo/df7-anchor-lifecycle.ts --pay --id <sep24-id>
      one classic memo payment; retains the hash before polling
  FP_DF7_ALLOW_NETWORK=1 node scripts/demo/df7-anchor-lifecycle.ts --reconcile
      read-only Horizon reconciliation of an uncertain submit; never resubmits
  node scripts/demo/df7-anchor-lifecycle.ts --classify --anchor-status completed \\
      --anchor-tx-id ... --anchor-payment-hash ... --vault-release-hash ... \\
      --withdraw-check pass
      offline classification; success requires completed + verified refs + a passed assertion

The classic memo payment is implemented behind the three gates above. It is not
executed by the plan, preflight, readiness, start-withdraw, poll or classify
modes. --pay sends at most one payment and refuses when retained state exists;
use --reconcile to recover the hash first.
`)
		process.exit(0)
	}
	if (modes.length > 1) {
		line("blocked", `choose one mode, got ${modes.join(", ")}`)
		process.exit(2)
	}
	switch (modes[0] ?? "plan") {
		case "preflight":
			return preflightMode()
		case "readiness":
			return readinessMode()
		case "start-withdraw":
			return startWithdrawMode()
		case "pay":
			return payMode()
		case "reconcile":
			return reconcileMode()
		case "poll":
			return pollMode()
		case "classify":
			return classifyMode()
		default:
			return planMode()
	}
}

await main()
