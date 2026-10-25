/**
 * DF7 — reference-anchor lifecycle scaffold (Stellar testnet).
 *
 * This script is deliberately a scaffold, not a DF7 acceptance run. It:
 * - loads Cursor's `testnet-ids-anchor-vault.env` and the CCR-20 names;
 * - checks local prerequisites and the recipient secret/public-key match;
 * - reports the lifecycle stages and classifies success/failure/pending;
 * - can perform read-only anchor readiness/polling and start a hosted session
 *   behind network gates, but never submits a classic payment here.
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
} from "../../packages/adapter-stellar/src/index.ts"
import {
	DF7_AMOUNT,
	checkDf7Prerequisites,
	classifyDf7Lifecycle,
	createDf7AnchorClient,
	formatDf7Stage,
	parseDf7Amount,
	planDf7Stages,
	saveHostedUrlForBrowser,
	type Df7Assertion,
	type Df7RefsInput,
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

const OUTCOME_EXIT = { SUCCESS: 0, FAILURE: 1, PENDING: 2, BLOCKED: 2 } as const

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
		"anchor_payment is intentionally not implemented in this scaffold; it is a live transaction.",
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
		if (tx.status === "completed") {
			line(
				"note",
				"assertion input is caller-supplied; this scaffold did not decode the classic payment",
			)
		}
		printRefs(refsFromArgs())
		const classification = classifyDf7Lifecycle({
			anchorStatus: tx.status,
			refs: refsFromArgs(),
			withdrawAssertion: assertion,
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
			refs: refsFromArgs(),
			withdrawAssertion: assertion,
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
      bounded read-only status poll
  node scripts/demo/df7-anchor-lifecycle.ts --classify --anchor-status completed \\
      --anchor-tx-id ... --anchor-payment-hash ... --vault-release-hash ... \\
      --withdraw-check pass
      offline classification; success requires all three distinct refs and a passed assertion

The classic memo payment is not implemented in this scaffold. It is a live
transaction and must be wired only after explicit approval.
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
		case "poll":
			return pollMode()
		case "classify":
			return classifyMode()
		default:
			return planMode()
	}
}

await main()
