/**
 * H1 — Stellar fee-drift / CCR-15 public-API driver (gated).
 *
 * Default: plan only (safe).
 * Prepare vault: FP_H1_PREPARE_VAULT=1 (baseline ids untouched).
 * Execute: FP_H1_CLAUDE_APPROVED=1 AND FP_H1_EXECUTE=1 (after Claude go).
 *
 * See scripts/demo/H1-REPRODUCTION.md.
 */
import { randomBytes } from "node:crypto"
import {
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs"
import type { AddressInfo } from "node:net"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { execFileSync } from "node:child_process"
import { loadConfig } from "@flexipay/domain"
import { createApp } from "../../apps/api/src/app.ts"
import { createDb, type Db } from "../../apps/api/src/db.ts"
import {
	migrateDeploy,
	startEmbeddedDb,
} from "../../apps/api/src/dev/embedded-db.ts"
import { newApiKey, newId } from "../../apps/api/src/ids.ts"
import { createApiRuntime } from "../../apps/api/src/runtime.ts"
import {
	loadStellarEnv,
	loadTestnetEnvFiles,
	PayoutVault,
} from "../../packages/adapter-stellar/src/index.ts"
import { parseEnvFile } from "../../packages/adapter-stellar/src/stellar-env.ts"
import {
	parseContractInvocation,
	parseNetworkPassphrase,
	parseTransactionResult,
	vaultExternalId,
} from "./lib/stellar-proof.ts"

const repoRoot = fileURLToPath(new URL("../..", import.meta.url))
const baselineIdsPath = resolve(repoRoot, "scripts/testnet/testnet-ids.env")
const h1IdsPath = resolve(repoRoot, "scripts/testnet/testnet-ids-h1-vault.env")
const secretsPath = resolve(repoRoot, "scripts/testnet/.env.secrets")
const planDoc = resolve(repoRoot, "scripts/demo/H1-REPRODUCTION.md")
const evidenceDir = resolve(repoRoot, "scripts/demo/evidence")
const privateDir = "/tmp/fp-h1-freebuff"

const APPROVED = process.env.FP_H1_CLAUDE_APPROVED === "1"
const EXECUTE = process.env.FP_H1_EXECUTE === "1"
const PREPARE = process.env.FP_H1_PREPARE_VAULT === "1"

function mustBaseline(): Record<string, string> {
	if (!existsSync(baselineIdsPath)) {
		throw new Error(`missing baseline ids ${baselineIdsPath}`)
	}
	return parseEnvFile(readFileSync(baselineIdsPath, "utf8"))
}

function printPlan(baseline: Record<string, string>): void {
	console.log(`H1 plan document: ${planDoc}`)
	console.log("")
	console.log("=== H1 targeted checks (gated; not run in plan mode) ===")
	console.log("1. Isolated DB + same seal key across Process A → B")
	console.log(
		"2. Quote/create under baseline vault",
		baseline.FP_PAYOUT_VAULT_ID,
		"fee",
		baseline.FP_VAULT_FEE_BPS,
	)
	console.log("3. Restart API env → H1 vault fee_bps=50 (same GBBO6N token)")
	console.log("4. POST /v1/payments/{id}/fund → 409 fee_drift")
	console.log(
		"5. Payment refunded; settle failed+fee_drift; lock+refund refs retained",
	)
	console.log(
		"6. POST /v1/claims/{token}/accept → 409 settle_failed (no release)",
	)
	console.log("7. Replay fund/accept: no duplicate lock/refund; never paid")
	console.log("8. Decode lock + refund on H1 vault; baseline vault untouched")
	console.log(
		"9. Balance before lock (B0 + deposit) equals balance after refund; no fee taken",
	)
	console.log("")
	console.log("Gates: FP_H1_CLAUDE_APPROVED=1 FP_H1_EXECUTE=1 required to run.")
	console.log(
		"Prepare only: FP_H1_PREPARE_VAULT=1 (deploy ids file; still no fund/drift).",
	)
}

function prepareVault(baseline: Record<string, string>): void {
	const stellar = `${process.env.HOME}/.cargo/bin/stellar`
	const bin = existsSync(stellar) ? stellar : "stellar"
	const net = "testnet"
	const alias = "fp-payout-vault-h1"
	const token = baseline.FP_USDC_CONTRACT_ID
	const treasury = baseline.FP_TREASURY_ADDRESS
	if (!token || !treasury)
		throw new Error("baseline missing USDC contract or treasury")

	console.log("LOCK deployer Cursor H1-prepare-vault", new Date().toISOString())
	process.env.CARGO_TARGET_DIR =
		process.env.CARGO_TARGET_DIR ?? resolve(repoRoot, "target")
	const wasmHint = resolve(
		repoRoot,
		"target/wasm32v1-none/release/payout_vault.wasm",
	)
	const buildOut = execFileSync(
		bin,
		["contract", "build", "--package", "payout-vault"],
		{
			cwd: repoRoot,
			encoding: "utf8",
		},
	)
	let wasm = wasmHint
	if (!existsSync(wasm)) {
		const m = /Wasm File:\s*(\S+)/.exec(buildOut)
		if (m) wasm = m[1]!
	}
	if (!existsSync(wasm))
		throw new Error("payout_vault.wasm not found after build")

	let vaultId = ""
	try {
		vaultId = execFileSync(
			bin,
			["contract", "alias", "show", alias, "--network", net],
			{ encoding: "utf8" },
		).trim()
	} catch {
		vaultId = ""
	}
	if (!vaultId || process.env.FP_REDEPLOY_H1_VAULT === "1") {
		vaultId = execFileSync(
			bin,
			[
				"contract",
				"deploy",
				"--wasm",
				wasm,
				"--source-account",
				"fp-deployer",
				"--network",
				net,
				"--alias",
				alias,
				"--",
				"--token",
				token,
				"--treasury",
				treasury,
				"--fee_bps",
				"50",
			],
			{ encoding: "utf8" },
		).trim()
	}
	const config = execFileSync(
		bin,
		[
			"contract",
			"invoke",
			"--id",
			vaultId,
			"--source-account",
			"fp-deployer",
			"--network",
			net,
			"--send",
			"no",
			"--",
			"config",
		],
		{ encoding: "utf8" },
	).trim()
	console.log("H1 vault", vaultId, "config", config)
	if (!config.includes(token) || !config.includes(treasury)) {
		throw new Error("H1 vault config token/treasury mismatch")
	}
	if (vaultId === baseline.FP_PAYOUT_VAULT_ID) {
		throw new Error("REFUSING: H1 vault id equals baseline vault")
	}

	const generatedAt = new Date().toISOString()
	writeFileSync(
		h1IdsPath,
		`# Generated by scripts/demo/h1-fee-drift-stellar.ts prepare on ${generatedAt}.
# Same token as baseline (GBBO6N); fee_bps=50. Does NOT replace testnet-ids.env.
FP_STELLAR_NETWORK=${baseline.FP_STELLAR_NETWORK}
FP_STELLAR_RPC_URL=${baseline.FP_STELLAR_RPC_URL}
FP_STELLAR_NETWORK_PASSPHRASE="${baseline.FP_STELLAR_NETWORK_PASSPHRASE}"
FP_USDC_ASSET=${baseline.FP_USDC_ASSET}
FP_USDC_CONTRACT_ID=${token}
FP_PAYOUT_VAULT_ID=${vaultId}
FP_VAULT_FEE_BPS=50
FP_TREASURY_ADDRESS=${treasury}
FP_PAYER_DEMO_ADDRESS=${baseline.FP_PAYER_DEMO_ADDRESS}
FP_RECIPIENT_A_ADDRESS=${baseline.FP_RECIPIENT_A_ADDRESS}
FP_RECIPIENT_B_ADDRESS=${baseline.FP_RECIPIENT_B_ADDRESS ?? ""}
FP_H1_VAULT_PURPOSE=fee-drift-same-token-50bps
FP_H1_BASELINE_VAULT_ID=${baseline.FP_PAYOUT_VAULT_ID}
`,
	)
	console.log("wrote", h1IdsPath)
	console.log(
		"UNLOCK deployer Cursor H1-prepare-vault",
		new Date().toISOString(),
	)
	console.log("Baseline ids untouched:", baselineIdsPath)
}

function auth(key: string): Record<string, string> {
	return {
		authorization: `Bearer ${key}`,
		"content-type": "application/json",
		accept: "application/json",
	}
}

async function jsonFetch(
	base: string,
	method: "GET" | "POST",
	path: string,
	opts: { key?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = { accept: "application/json" }
	if (opts.auth !== false && opts.key) Object.assign(headers, auth(opts.key))
	else if (opts.body !== undefined) headers["content-type"] = "application/json"
	const res = await fetch(`${base}${path}`, {
		method,
		headers,
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
		signal: AbortSignal.timeout(300_000),
	})
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
	return { status: res.status, body }
}

async function startApi(opts: {
	databaseUrl: string
	sealKey: string
	port: number
	publicEnv: Record<string, string>
}): Promise<{ base: string; stop: () => Promise<void>; db: Db }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		...opts.publicEnv,
		...(existsSync(secretsPath)
			? parseEnvFile(readFileSync(secretsPath, "utf8"))
			: {}),
		DATABASE_URL: opts.databaseUrl,
		FP_SETTLEMENT: "stellar",
		FP_CLAIM_SEAL_KEY: opts.sealKey,
		FP_API_URL: `http://127.0.0.1:${opts.port}`,
		PORT: String(opts.port),
	}
	for (const [k, v] of Object.entries(env)) {
		if (v !== undefined) process.env[k] = v
	}
	const configDir = resolve(repoRoot, "config")
	const loaded = await loadConfig(configDir)
	if (!loaded.ok)
		throw new Error(`config invalid: ${JSON.stringify(loaded.issues)}`)
	const runtime = await createApiRuntime(loaded.config, env)
	if (
		(await runtime.settlement.feeBps()) !==
		Number(opts.publicEnv.FP_VAULT_FEE_BPS)
	) {
		throw new Error(
			`feeBps mismatch: on-chain ${await runtime.settlement.feeBps()} vs env ${opts.publicEnv.FP_VAULT_FEE_BPS}`,
		)
	}
	const db = createDb(opts.databaseUrl)
	const server = createApp({ db, config: loaded.config, runtime }).listen(
		opts.port,
		"127.0.0.1",
	)
	await new Promise<void>((r) => server.once("listening", () => r()))
	const addr = server.address() as AddressInfo
	return {
		base: `http://127.0.0.1:${addr.port}`,
		db,
		async stop() {
			await new Promise<void>((r) => server.close(() => r()))
			await db.$disconnect()
		},
	}
}

async function provisionOrg(db: Db): Promise<{ key: string }> {
	const org = await db.organization.create({
		data: { id: newId("org"), name: "H1 Drift Demo", kind: "business" },
	})
	const k = newApiKey()
	await db.apiKey.create({
		data: {
			id: newId("key"),
			organizationId: org.id,
			prefix: k.prefix,
			keyHash: k.keyHash,
		},
	})
	return { key: k.key }
}

function settleOf(
	payment: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const legs = payment.legs
	if (!Array.isArray(legs)) return undefined
	return legs.find((l) => (l as { kind?: string }).kind === "settle") as
		Record<string, unknown> | undefined
}

async function rpcGetTransaction(
	rpcUrl: string,
	hash: string,
): Promise<{ status: string; ledger: number; envelopeXdr: string }> {
	const res = await fetch(rpcUrl, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "getTransaction",
			params: { hash },
		}),
		signal: AbortSignal.timeout(60_000),
	})
	const body = (await res.json()) as {
		result?: { status?: string; ledger?: number; envelopeXdr?: string }
		error?: { message?: string }
	}
	if (body.error) throw new Error(`RPC getTransaction: ${body.error.message}`)
	const { status, ledger } = parseTransactionResult(body.result)
	const envelopeXdr = body.result?.envelopeXdr
	if (typeof envelopeXdr !== "string") throw new Error("missing envelopeXdr")
	return { status, ledger, envelopeXdr }
}

async function decodeVaultCall(
	rpcUrl: string,
	networkPassphrase: string,
	hash: string,
	expectedVault: string,
): Promise<{
	hash: string
	status: string
	ledger: number
	functionName: string
	contractId: string
	args: unknown[]
}> {
	const net = await fetch(rpcUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "getNetwork",
			params: {},
		}),
		signal: AbortSignal.timeout(30_000),
	})
	const netBody = (await net.json()) as { result?: unknown }
	const passphrase = parseNetworkPassphrase(netBody.result)
	if (passphrase !== networkPassphrase) {
		throw new Error(`RPC passphrase mismatch: ${passphrase}`)
	}
	const tx = await rpcGetTransaction(rpcUrl, hash)
	if (tx.status !== "SUCCESS") throw new Error(`tx ${hash} status ${tx.status}`)
	const inv = parseContractInvocation(tx.envelopeXdr, networkPassphrase)
	if (inv.contractId !== expectedVault) {
		throw new Error(
			`invocation contract ${inv.contractId} != H1 vault ${expectedVault}`,
		)
	}
	return {
		hash,
		status: tx.status,
		ledger: tx.ledger,
		functionName: inv.functionName,
		contractId: inv.contractId,
		args: inv.args,
	}
}

async function executeScenario(
	baseline: Record<string, string>,
): Promise<void> {
	const h1 = parseEnvFile(readFileSync(h1IdsPath, "utf8"))
	if (h1.FP_PAYOUT_VAULT_ID === baseline.FP_PAYOUT_VAULT_ID) {
		throw new Error("REFUSING: H1 vault id equals baseline")
	}
	if (h1.FP_USDC_CONTRACT_ID !== baseline.FP_USDC_CONTRACT_ID) {
		throw new Error("REFUSING: H1 must use same-token as baseline")
	}
	if (Number(h1.FP_VAULT_FEE_BPS) !== 50) {
		throw new Error(`REFUSING: H1 fee must be 50, got ${h1.FP_VAULT_FEE_BPS}`)
	}
	if (!existsSync(secretsPath)) {
		throw new Error(
			`missing ${secretsPath} (gitignored; generate from stellar keys)`,
		)
	}

	const sealKey = randomBytes(32).toString("hex")
	const recipientA = baseline.FP_RECIPIENT_A_ADDRESS!
	const payerAddr = baseline.FP_PAYER_DEMO_ADDRESS!
	const baselineFeeBps = Number(baseline.FP_VAULT_FEE_BPS)
	if (baselineFeeBps !== 100) {
		throw new Error(`baseline fee must be 100, got ${baselineFeeBps}`)
	}
	const apiPort = 8793
	mkdirSync(privateDir, { recursive: true, mode: 0o700 })
	mkdirSync(evidenceDir, { recursive: true })

	const h1Merged = loadTestnetEnvFiles({
		idsPath: h1IdsPath,
		secretsPath,
	})
	const h1Vault = await PayoutVault.connect(loadStellarEnv(h1Merged))
	const h1FeeBps = await h1Vault.feeBps()
	if (h1FeeBps !== 50) {
		throw new Error(`H1 on-chain fee must be 50, got ${h1FeeBps}`)
	}

	console.log(
		"LOCK payer Freebuff H1-fee-drift (configuration drift between vaults)",
		new Date().toISOString(),
	)

	const pgDir = resolve(repoRoot, "apps/api/.pgdata-h1-drift-freebuff")
	const pg = await startEmbeddedDb({
		dir: pgDir,
		port: 54343,
		name: "flexipay_h1",
	})
	await migrateDeploy(pg.url)

	// Process A: baseline vault (100 bps) — quote + create only
	let api = await startApi({
		databaseUrl: pg.url,
		sealKey,
		port: apiPort,
		publicEnv: baseline,
	})
	const { key: apiKey } = await provisionOrg(api.db)

	const recipient = await jsonFetch(api.base, "POST", "/v1/recipients", {
		key: apiKey,
		body: { name: "Worker A", kind: "individual", country: "PH" },
	})
	if (recipient.status >= 300) {
		throw new Error(
			`recipient ${recipient.status}: ${JSON.stringify(recipient.body)}`,
		)
	}
	const recipientId = String(recipient.body.id)

	await jsonFetch(api.base, "POST", "/v1/endpoints", {
		key: apiKey,
		body: {
			recipientId,
			type: "crypto_wallet",
			country: "",
			currency: "USDC",
			network: "stellar",
			details: { address: recipientA },
			simulated: true,
		},
	})

	const quote = await jsonFetch(api.base, "POST", "/v1/quotes", {
		key: apiKey,
		body: {
			source: { type: "bank_account", currency: "USD", country: "US" },
			destination: {
				type: "crypto_wallet",
				country: "PH",
				currency: "USDC",
				recipientKind: "individual",
			},
			amount: { side: "send", value: { amount: "200", currency: "USD" } },
			feeMode: "PayerPays",
			policy: "cheapest",
		},
	})
	if (quote.status >= 300) {
		throw new Error(`quote ${quote.status}: ${JSON.stringify(quote.body)}`)
	}
	const quoteId = String(quote.body.id)
	const frozenFee = (
		quote.body.fees as { flexiPayFee?: { amount?: string } } | undefined
	)?.flexiPayFee?.amount

	const created = await jsonFetch(api.base, "POST", "/v1/payments", {
		key: apiKey,
		body: {
			quoteId,
			recipientId,
			externalId: `h1-drift-${Date.now().toString(36)}`,
			delivery: "claim_link",
			profile: "one_off",
		},
	})
	if (created.status >= 300) {
		throw new Error(
			`payment ${created.status}: ${JSON.stringify(created.body)}`,
		)
	}
	const paymentId = String(created.body.id)
	const claimUrl = String(
		(created.body.claimLink as { url?: string } | null)?.url ?? "",
	)
	const claimToken = claimUrl.slice(claimUrl.lastIndexOf("/") + 1)
	if (!claimToken) throw new Error("no claim token")
	writeFileSync(`${privateDir}/h1-claim-token.txt`, claimToken, { mode: 0o600 })

	await api.stop()

	// Process B: H1 vault (50 bps), same DB + seal — fund drifts
	api = await startApi({
		databaseUrl: pg.url,
		sealKey,
		port: apiPort,
		publicEnv: h1,
	})

	const balanceBeforeFund = await h1Vault.balance(payerAddr)
	console.log(
		"vault balance before fund/lock path",
		balanceBeforeFund.toString(),
	)

	const fund = await jsonFetch(
		api.base,
		"POST",
		`/v1/payments/${paymentId}/fund`,
		{
			key: apiKey,
			body: {},
		},
	)
	if (fund.status !== 409 || fund.body.code !== "fee_drift") {
		throw new Error(
			`expected 409 fee_drift, got ${fund.status} ${JSON.stringify(fund.body)}`,
		)
	}

	const afterDrift = await jsonFetch(
		api.base,
		"GET",
		`/v1/payments/${paymentId}`,
		{
			key: apiKey,
		},
	)
	const settle = settleOf(afterDrift.body)
	if (String(afterDrift.body.status) !== "refunded") {
		throw new Error(`expected refunded, got ${afterDrift.body.status}`)
	}
	const settleErrorCode =
		(settle?.error as { code?: string } | undefined)?.code ?? settle?.errorCode
	if (
		!settle ||
		settle.status !== "failed" ||
		settleErrorCode !== "fee_drift" ||
		!settle.externalRef ||
		!settle.lockTxRef ||
		!settle.releaseTxRef
	) {
		throw new Error(`settle state after drift: ${JSON.stringify(settle)}`)
	}
	const payoutId = String(settle.externalRef)
	const lockTxRef = String(settle.lockTxRef)
	const refundTxRef = String(settle.releaseTxRef)

	const principal = BigInt(
		String((settle.amountIn as { amount?: string } | undefined)?.amount ?? ""),
	)
	const frozenFeeMinor = BigInt(String(frozenFee ?? ""))
	if (principal <= 0n || frozenFeeMinor <= 0n) {
		throw new Error(
			`frozen principal/fee missing: principal=${principal} fee=${frozenFeeMinor}`,
		)
	}
	const expectedFeeAtBaseline = (principal * BigInt(baselineFeeBps)) / 10_000n
	if (frozenFeeMinor !== expectedFeeAtBaseline) {
		throw new Error(
			`frozen fee ${frozenFeeMinor} != floor(P*${baselineFeeBps}/10000)=${expectedFeeAtBaseline}`,
		)
	}
	const expectedFeeAtH1 = (principal * BigInt(h1FeeBps)) / 10_000n

	const payout = await h1Vault.getPayout(BigInt(payoutId))
	if (payout.status !== "Refunded") {
		throw new Error(`payout ${payoutId} is ${payout.status}, expected Refunded`)
	}
	if (payout.gross !== principal || payout.net !== principal) {
		throw new Error(
			`payout gross/net ${payout.gross}/${payout.net} != frozen principal ${principal}`,
		)
	}
	if (payout.fee !== expectedFeeAtH1) {
		throw new Error(
			`decoded vault fee ${payout.fee} != floor(P*${h1FeeBps}/10000)=${expectedFeeAtH1}`,
		)
	}
	if (payout.locked !== principal + expectedFeeAtH1) {
		throw new Error(
			`payout locked ${payout.locked} != P+fee ${principal + expectedFeeAtH1}`,
		)
	}
	if (payout.fee >= frozenFeeMinor) {
		throw new Error(
			`H1 fee ${payout.fee} is not below frozen ${baselineFeeBps}-bps fee ${frozenFeeMinor}`,
		)
	}

	// PayerPays deposit is exactly P + frozen 100-bps fee (run.ts). The lock debits
	// P + its own fee; a successful refund restores that debit. Therefore the only
	// expected difference from before-fund is the deposit, and before-lock must equal
	// after-refund exactly.
	const depositMinor = principal + frozenFeeMinor
	const balanceBeforeLock = balanceBeforeFund + depositMinor
	const balanceAfterRefund = await h1Vault.balance(payerAddr)
	console.log(
		"vault balance before lock (B0+deposit)",
		balanceBeforeLock.toString(),
		"after refund",
		balanceAfterRefund.toString(),
	)
	if (balanceAfterRefund !== balanceBeforeLock) {
		throw new Error(
			`payer vault balance changed across lock/refund: before-lock=${balanceBeforeLock} after-refund=${balanceAfterRefund}`,
		)
	}

	const acceptBody = {
		endpoint: {
			type: "crypto_wallet",
			country: "",
			currency: "USDC",
			network: "stellar",
			details: { address: recipientA },
			simulated: true,
		},
	}
	const accept = await jsonFetch(
		api.base,
		"POST",
		`/v1/claims/${claimToken}/accept`,
		{ auth: false, body: acceptBody },
	)
	if (accept.status !== 409 || accept.body.code !== "settle_failed") {
		throw new Error(
			`expected accept 409 settle_failed, got ${accept.status} ${JSON.stringify(accept.body)}`,
		)
	}
	const claimView = await jsonFetch(
		api.base,
		"GET",
		`/v1/claims/${claimToken}`,
		{
			auth: false,
		},
	)
	if (String(claimView.body.status) !== "open") {
		throw new Error(`claim should stay open, got ${claimView.body.status}`)
	}

	// Replays — no duplicate funding/locks/refunds
	const fundReplay = await jsonFetch(
		api.base,
		"POST",
		`/v1/payments/${paymentId}/fund`,
		{ key: apiKey, body: {} },
	)
	if (
		fundReplay.status !== 200 ||
		String(fundReplay.body.status) !== "refunded"
	) {
		throw new Error(
			`fund replay expected 200 refunded, got ${fundReplay.status} ${JSON.stringify(fundReplay.body)}`,
		)
	}
	const acceptReplay = await jsonFetch(
		api.base,
		"POST",
		`/v1/claims/${claimToken}/accept`,
		{ auth: false, body: acceptBody },
	)
	if (
		acceptReplay.status !== 409 ||
		acceptReplay.body.code !== "settle_failed"
	) {
		throw new Error(`accept replay failed: ${acceptReplay.status}`)
	}
	const afterReplay = await jsonFetch(
		api.base,
		"GET",
		`/v1/payments/${paymentId}`,
		{
			key: apiKey,
		},
	)
	const settleReplay = settleOf(afterReplay.body)
	if (
		String(settleReplay?.externalRef) !== payoutId ||
		String(settleReplay?.lockTxRef) !== lockTxRef ||
		String(settleReplay?.releaseTxRef) !== refundTxRef
	) {
		throw new Error("replay changed settle refs (duplicate risk)")
	}
	const byExternal = await h1Vault.payoutByExternal(
		payerAddr,
		Buffer.from(vaultExternalId(paymentId), "hex"),
	)
	if (byExternal === undefined || byExternal.toString() !== payoutId) {
		throw new Error(
			`payout_by_external returned ${byExternal?.toString() ?? "none"}, expected ${payoutId}`,
		)
	}

	const rpcUrl = h1.FP_STELLAR_RPC_URL!
	const passphrase = h1.FP_STELLAR_NETWORK_PASSPHRASE!
	const lockDecoded = await decodeVaultCall(
		rpcUrl,
		passphrase,
		lockTxRef,
		h1.FP_PAYOUT_VAULT_ID!,
	)
	const refundDecoded = await decodeVaultCall(
		rpcUrl,
		passphrase,
		refundTxRef,
		h1.FP_PAYOUT_VAULT_ID!,
	)
	if (lockDecoded.functionName !== "create_payout") {
		throw new Error(
			`lock fn ${lockDecoded.functionName}, expected create_payout`,
		)
	}
	if (
		refundDecoded.functionName !== "cancel" &&
		refundDecoded.functionName !== "refund"
	) {
		throw new Error(
			`refund fn ${refundDecoded.functionName}, expected cancel|refund`,
		)
	}
	const lockAmount = lockDecoded.args[3]
	const lockMode = lockDecoded.args[4]
	const modeSym = Array.isArray(lockMode)
		? String(lockMode[0])
		: String(lockMode)
	const lockAmountStr =
		typeof lockAmount === "bigint" ? lockAmount.toString() : String(lockAmount)
	if (lockAmountStr !== principal.toString()) {
		throw new Error(
			`decoded lock principal ${lockAmountStr} != frozen principal ${principal}`,
		)
	}
	if (modeSym !== "PayerPays") {
		throw new Error(`unexpected lock feeMode ${modeSym}, expected PayerPays`)
	}
	const refundPayoutArg = refundDecoded.args[0]
	const refundPayoutId =
		typeof refundPayoutArg === "bigint"
			? refundPayoutArg.toString()
			: String(refundPayoutArg)
	if (refundPayoutId !== payoutId) {
		throw new Error(
			`decoded refund payout ${refundPayoutId} != locked payout ${payoutId}`,
		)
	}

	const evidence = {
		milestone: "H1",
		title:
			"Stellar fee-drift / CCR-15 public API (configuration drift between vaults)",
		status: "PASS",
		label:
			"configuration drift between vaults (quote @ baseline 100 bps → fund @ isolated 50 bps); not an on-chain fee change of the baseline vault",
		baselineVaultId: baseline.FP_PAYOUT_VAULT_ID,
		h1VaultId: h1.FP_PAYOUT_VAULT_ID,
		sameToken: h1.FP_USDC_CONTRACT_ID,
		baselineFeeBps,
		h1FeeBps,
		frozenPrincipal: principal.toString(),
		frozenFlexiPayFee: frozenFeeMinor.toString(),
		paymentId,
		payoutId,
		lockTxRef,
		refundTxRef,
		fundHttp: { status: fund.status, code: fund.body.code },
		paymentStatus: afterDrift.body.status,
		claimAccept: { status: accept.status, code: accept.body.code },
		claimStatus: claimView.body.status,
		decodedLock: {
			functionName: lockDecoded.functionName,
			amount: lockAmountStr,
			feeMode: modeSym,
			fee: payout.fee.toString(),
			locked: payout.locked.toString(),
			net: payout.net.toString(),
			status: payout.status,
			contractId: lockDecoded.contractId,
		},
		conservation: {
			balanceBeforeFund: balanceBeforeFund.toString(),
			depositPayerPays: depositMinor.toString(),
			balanceBeforeLock: balanceBeforeLock.toString(),
			balanceAfterRefund: balanceAfterRefund.toString(),
			exactEquality: balanceAfterRefund === balanceBeforeLock,
			noFeeTaken: true,
		},
		replay: {
			fundStatus: fundReplay.status,
			fundPaymentStatus: fundReplay.body.status,
			acceptStatus: acceptReplay.status,
			acceptCode: acceptReplay.body.code,
			refsUnchanged: true,
			payoutByExternal: byExternal.toString(),
			noSecondLock: true,
		},
		decoded: { lock: lockDecoded, refund: refundDecoded },
		completedAt: new Date().toISOString(),
	}

	const jsonSafe = (value: unknown) =>
		JSON.stringify(
			value,
			(_key, item) => (typeof item === "bigint" ? item.toString() : item),
			2,
		)

	const outPath = resolve(evidenceDir, "2026-10-25-h1-fee-drift-stellar.md")
	writeFileSync(
		outPath,
		`# H1 — Stellar fee-drift / CCR-15 (25 Oct 2026)

**Status: PASS** (isolated DB; baseline vault untouched)

**Label:** configuration drift between vaults (quote @ baseline **100** bps → fund @ isolated **50** bps) — not an on-chain fee change of the baseline vault.

| Step | Result |
| --- | --- |
| Quote/create @ baseline ${baseline.FP_PAYOUT_VAULT_ID} (100 bps) | payment \`${paymentId}\`; principal \`${principal}\`; frozen flexiPayFee \`${frozenFeeMinor}\` |
| Restart @ H1 vault \`${h1.FP_PAYOUT_VAULT_ID}\` (50 bps) → fund | **409** \`fee_drift\` |
| After drift | payment **refunded**; settle **failed**/\`fee_drift\`; payoutId \`${payoutId}\` |
| Decoded lock | \`create_payout\` amount \`${lockAmountStr}\`, fee \`${payout.fee}\`, locked \`${payout.locked}\`, status \`${payout.status}\` |
| Decoded refund | \`${refundDecoded.functionName}\` payout \`${refundPayoutId}\` on the same vault |
| Claim accept | **409** \`settle_failed\`; claim stays **open** |
| Lock tx | \`${lockTxRef}\` |
| Refund tx (\`releaseTxRef\`) | \`${refundTxRef}\` |
| Conservation | before fund \`${balanceBeforeFund}\` + deposit \`${depositMinor}\` = before lock \`${balanceBeforeLock}\` = after refund \`${balanceAfterRefund}\`; no fee taken |
| Replay fund/accept | 200 refunded / 409 settle_failed; refs unchanged; \`payout_by_external\` = \`${byExternal}\` |

## Decoded

\`\`\`json
${jsonSafe({ lock: lockDecoded, refund: refundDecoded, payout })}
\`\`\`

## Machine-readable

\`\`\`json
${jsonSafe(evidence)}
\`\`\`
`,
	)
	writeFileSync(`${privateDir}/h1-result.json`, jsonSafe(evidence))
	try {
		unlinkSync(`${privateDir}/h1-claim-token.txt`)
	} catch {
		/* ignore */
	}

	await api.stop()
	await pg.stop()
	console.log("UNLOCK payer Freebuff H1-fee-drift", new Date().toISOString())
	console.log("H1 PASS evidence →", outPath)
}

const baseline = mustBaseline()
printPlan(baseline)

if (PREPARE) {
	prepareVault(baseline)
}

if (EXECUTE) {
	if (!APPROVED) {
		console.error("Refusing execute: FP_H1_CLAUDE_APPROVED=1 is required.")
		process.exit(2)
	}
	if (!existsSync(h1IdsPath)) {
		console.error(
			`Refusing execute: missing ${h1IdsPath} — run with FP_H1_PREPARE_VAULT=1 first.`,
		)
		process.exit(2)
	}
	await executeScenario(baseline)
} else {
	console.log("Plan mode complete — no fund/drift scenario run.")
}
