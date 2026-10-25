/**
 * H2 — different-seal-key negative control (isolated DB).
 *
 * 1. Seal key A: create + fund claim_link (settle locked, claim open).
 * 2. Restart API with seal key B (same DATABASE_URL): accept must fail; no release.
 * 3. Restart API with seal key A: the SAME claim accepts and releases.
 *
 * Default settlement is Stellar so vault state survives process restart.
 * Evidence records ids/hashes/statuses only — never tokens, secrets, or seal keys.
 *
 * Usage (repo root):
 *   FP_SETTLEMENT=stellar npx tsx scripts/demo/h2-seal-key-negative.ts
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@flexipay/domain";
import { createApp } from "../../apps/api/src/app.ts";
import { createDb, type Db } from "../../apps/api/src/db.ts";
import {
	migrateDeploy,
	startEmbeddedDb,
} from "../../apps/api/src/dev/embedded-db.ts";
import { newApiKey, newId } from "../../apps/api/src/ids.ts";
import { createApiRuntime } from "../../apps/api/src/runtime.ts";
import { parseEnvFile } from "../../packages/adapter-stellar/src/stellar-env.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const idsPath = resolve(repoRoot, "scripts/testnet/testnet-ids.env");
const secretsPath = resolve(repoRoot, "scripts/testnet/.env.secrets");
const evidenceDir = resolve(repoRoot, "scripts/demo/evidence");
const privateDir = "/tmp/fp-e1-private";

const KEY_A = randomBytes(32).toString("hex");
const KEY_B = randomBytes(32).toString("hex");
if (KEY_A === KEY_B) throw new Error("seal keys collided");

function loadPublicIds(): Record<string, string> {
	if (!existsSync(idsPath)) throw new Error(`missing ${idsPath}`);
	return parseEnvFile(readFileSync(idsPath, "utf8"));
}

function auth(key: string): Record<string, string> {
	return {
		authorization: `Bearer ${key}`,
		"content-type": "application/json",
		accept: "application/json",
	};
}

async function jsonFetch(
	base: string,
	method: "GET" | "POST",
	path: string,
	opts: { key?: string; body?: unknown; auth?: boolean } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
	const headers: Record<string, string> = { accept: "application/json" };
	if (opts.auth !== false && opts.key) {
		Object.assign(headers, auth(opts.key));
	} else if (opts.body !== undefined) {
		headers["content-type"] = "application/json";
	}
	const res = await fetch(`${base}${path}`, {
		method,
		headers,
		...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
		signal: AbortSignal.timeout(180_000),
	});
	const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
	return { status: res.status, body };
}

async function startApi(opts: {
	databaseUrl: string;
	sealKey: string;
	port: number;
	publicEnv: Record<string, string>;
}): Promise<{ base: string; stop: () => Promise<void>; db: Db }> {
	const env: Record<string, string | undefined> = {
		...process.env,
		...opts.publicEnv,
		...(existsSync(secretsPath) ? parseEnvFile(readFileSync(secretsPath, "utf8")) : {}),
		DATABASE_URL: opts.databaseUrl,
		FP_SETTLEMENT: process.env.FP_SETTLEMENT ?? "stellar",
		FP_CLAIM_SEAL_KEY: opts.sealKey,
		FP_API_URL: `http://127.0.0.1:${opts.port}`,
		PORT: String(opts.port),
	};
	for (const [k, v] of Object.entries(env)) {
		if (v !== undefined) process.env[k] = v;
	}

	const configDir = resolve(repoRoot, "config");
	const loaded = await loadConfig(configDir);
	if (!loaded.ok) throw new Error(`config invalid: ${JSON.stringify(loaded.issues)}`);

	const runtime = await createApiRuntime(loaded.config, env);
	const db = createDb(opts.databaseUrl);
	const server = createApp({ db, config: loaded.config, runtime }).listen(
		opts.port,
		"127.0.0.1",
	);
	await new Promise<void>((r) => server.once("listening", () => r()));
	const addr = server.address() as AddressInfo;
	const base = `http://127.0.0.1:${addr.port}`;
	return {
		base,
		db,
		async stop() {
			await new Promise<void>((r) => server.close(() => r()));
			await db.$disconnect();
		},
	};
}

async function provisionOrg(db: Db): Promise<{ orgId: string; key: string }> {
	const org = await db.organization.create({
		data: { id: newId("org"), name: "H2 Seal Demo", kind: "business" },
	});
	const k = newApiKey();
	await db.apiKey.create({
		data: {
			id: newId("key"),
			organizationId: org.id,
			prefix: k.prefix,
			keyHash: k.keyHash,
		},
	});
	return { orgId: org.id, key: k.key };
}

function settleOf(payment: Record<string, unknown>): Record<string, unknown> | undefined {
	const legs = payment.legs;
	if (!Array.isArray(legs)) return undefined;
	return legs.find((l) => (l as { kind?: string }).kind === "settle") as
		| Record<string, unknown>
		| undefined;
}

console.log(
	`LOCK payer+recipientA Cursor H2-seal-negative ${new Date().toISOString()}`,
);

const publicIds = loadPublicIds();
const recipientA = publicIds.FP_RECIPIENT_A_ADDRESS;
if (!recipientA) throw new Error("FP_RECIPIENT_A_ADDRESS required");

mkdirSync(privateDir, { recursive: true, mode: 0o700 });
mkdirSync(evidenceDir, { recursive: true });

const pgDir = resolve(repoRoot, "apps/api/.pgdata-h2-seal");
const pg = await startEmbeddedDb({ dir: pgDir, port: 54341, name: "flexipay_h2" });
console.log("isolated DB ready");
await migrateDeploy(pg.url);

const apiPort = 8791;
let api = await startApi({
	databaseUrl: pg.url,
	sealKey: KEY_A,
	port: apiPort,
	publicEnv: publicIds,
});
const { key: apiKey } = await provisionOrg(api.db);

const health = await jsonFetch(api.base, "GET", "/healthz", { auth: false });
if (health.status !== 200) throw new Error(`healthz ${health.status}`);

// Recipient + crypto endpoint (claim destination identity; accept supplies address).
const recipient = await jsonFetch(api.base, "POST", "/v1/recipients", {
	key: apiKey,
	body: { name: "Worker A", kind: "individual", country: "PH" },
});
if (recipient.status !== 201 && recipient.status !== 200) {
	throw new Error(`recipient ${recipient.status}: ${JSON.stringify(recipient.body)}`);
}
const recipientId = String(recipient.body.id);

const endpoint = await jsonFetch(api.base, "POST", "/v1/endpoints", {
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
});
if (endpoint.status !== 201 && endpoint.status !== 200) {
	throw new Error(`endpoint ${endpoint.status}: ${JSON.stringify(endpoint.body)}`);
}
const endpointId = String(endpoint.body.id);

const quote = await jsonFetch(api.base, "POST", "/v1/quotes", {
	key: apiKey,
	body: {
		source: { type: "bank_account", currency: "USD", country: "US" },
		destination: {
			type: "crypto_wallet",
			// Quote corridor disambiguation (A0); accept endpoint still uses country "".
			country: "PH",
			currency: "USDC",
			recipientKind: "individual",
		},
		// Small USD send → settle ~USDC (keeps vault fund modest)
		amount: { side: "send", value: { amount: "200", currency: "USD" } },
		feeMode: "PayerPays",
		policy: "cheapest",
	},
});
if (quote.status !== 201 && quote.status !== 200) {
	throw new Error(`quote ${quote.status}: ${JSON.stringify(quote.body)}`);
}
const quoteId = String(quote.body.id);

const created = await jsonFetch(api.base, "POST", "/v1/payments", {
	key: apiKey,
	body: {
		quoteId,
		recipientId,
		externalId: `h2-seal-${Date.now().toString(36)}`,
		delivery: "claim_link",
		profile: "one_off",
	},
});
if (created.status !== 201 && created.status !== 200) {
	throw new Error(`payment ${created.status}: ${JSON.stringify(created.body)}`);
}
const paymentId = String(created.body.id ?? "");
const claimUrl = String(
	(created.body.claimLink as { url?: string } | null | undefined)?.url ?? "",
);
const claimToken = claimUrl.includes("/v1/claims/")
	? claimUrl.slice(claimUrl.lastIndexOf("/") + 1)
	: "";
if (!paymentId || !claimToken) {
	throw new Error(
		`payment create missing id/token: ${JSON.stringify({ status: created.status, keys: Object.keys(created.body) })}`,
	);
}
// Private only — never evidence.
writeFileSync(`${privateDir}/h2-claim-token.txt`, claimToken, { mode: 0o600 });

const funded = await jsonFetch(api.base, "POST", `/v1/payments/${paymentId}/fund`, {
	key: apiKey,
	body: {},
});
if (funded.status !== 200 && funded.status !== 201) {
	throw new Error(`fund ${funded.status}: ${JSON.stringify(funded.body)}`);
}

let payment = funded.body as Record<string, unknown>;
for (let i = 0; i < 60; i++) {
	const st = String(payment.status);
	if (st === "processing" || st === "paid" || st === "failed") break;
	await new Promise((r) => setTimeout(r, 2000));
	const polled = await jsonFetch(api.base, "GET", `/v1/payments/${paymentId}`, {
		key: apiKey,
	});
	payment = polled.body;
}
const settleFunded = settleOf(payment);
if (!settleFunded?.externalRef || !settleFunded.lockTxRef) {
	throw new Error(`fund did not lock: ${JSON.stringify(settleFunded)}`);
}
if (String(payment.status) === "paid") {
	throw new Error("payment paid before claim accept — abort");
}
const payoutId = String(settleFunded.externalRef);
const lockTxRef = String(settleFunded.lockTxRef);
console.log("funded locked", { paymentId, payoutId, lockTxRef: lockTxRef.slice(0, 12) });

// --- Restart with WRONG seal key ---
await api.stop();
api = await startApi({
	databaseUrl: pg.url,
	sealKey: KEY_B,
	port: apiPort,
	publicEnv: publicIds,
});

const acceptBody = {
	endpoint: {
		type: "crypto_wallet",
		country: "",
		currency: "USDC",
		network: "stellar",
		details: { address: recipientA },
		simulated: true,
	},
};

const wrong = await jsonFetch(api.base, "POST", `/v1/claims/${claimToken}/accept`, {
	auth: false,
	body: acceptBody,
});
const wrongBodyStr = JSON.stringify(wrong.body);
if (wrongBodyStr.includes(claimToken)) {
	throw new Error("wrong-key response leaked claim token");
}
if (/secretSealed|secretHex|FP_CLAIM_SEAL/i.test(wrongBodyStr)) {
	throw new Error("wrong-key response leaked seal material");
}

const afterWrong = await jsonFetch(api.base, "GET", `/v1/payments/${paymentId}`, {
	key: apiKey,
});
const settleWrong = settleOf(afterWrong.body);
const claimWrong = await jsonFetch(api.base, "GET", `/v1/claims/${claimToken}`, {
	auth: false,
});
const claimWrongStatus = String(
	(claimWrong.body as { status?: string }).status ?? "unknown",
);

const wrongOk =
	wrong.status >= 400 &&
	String(afterWrong.body.status) !== "paid" &&
	!settleWrong?.releaseTxRef &&
	claimWrongStatus !== "accepted";

if (!wrongOk) {
	throw new Error(
		`H2 wrong-key did not fail safely: accept=${wrong.status} payment=${afterWrong.body.status} release=${settleWrong?.releaseTxRef} claim=${claimWrongStatus} body=${wrongBodyStr.slice(0, 300)}`,
	);
}
console.log("wrong-key refused", {
	status: wrong.status,
	code: wrong.body.code,
	paymentStatus: afterWrong.body.status,
	claimStatus: claimWrongStatus,
	releaseTxRef: settleWrong?.releaseTxRef ?? null,
});

// endpointId retained for evidence only (accept uses inline endpoint)
void endpointId;

// --- Restore ORIGINAL seal key; SAME claim ---
await api.stop();
api = await startApi({
	databaseUrl: pg.url,
	sealKey: KEY_A,
	port: apiPort,
	publicEnv: publicIds,
});

const accepted = await jsonFetch(api.base, "POST", `/v1/claims/${claimToken}/accept`, {
	auth: false,
	body: acceptBody,
});
if (accepted.status !== 200 && accepted.status !== 201) {
	throw new Error(`restore accept ${accepted.status}: ${JSON.stringify(accepted.body)}`);
}

const afterOk = await jsonFetch(api.base, "GET", `/v1/payments/${paymentId}`, {
	key: apiKey,
});
const settleOk = settleOf(afterOk.body);
if (String(afterOk.body.status) !== "paid" || !settleOk?.releaseTxRef) {
	throw new Error(
		`restore did not complete same claim: ${JSON.stringify({ status: afterOk.body.status, settle: settleOk })}`,
	);
}
if (String(settleOk.externalRef) !== payoutId) {
	throw new Error(`payoutId changed across H2: ${settleOk.externalRef} vs ${payoutId}`);
}

const releaseTxRef = String(settleOk.releaseTxRef);
console.log("restored key accepted same claim", {
	paymentId,
	payoutId,
	releaseTxRef: releaseTxRef.slice(0, 12),
	status: afterOk.body.status,
});

const evidence = {
	milestone: "H2",
	title: "different-seal-key negative control",
	commitHint: "event/csenge-cursor/E1-anchor-cashout (run from working tree; push with evidence)",
	settlement: process.env.FP_SETTLEMENT ?? "stellar",
	vaultId: publicIds.FP_PAYOUT_VAULT_ID,
	isolatedDb: true,
	pgPort: 54341,
	apiPort,
	paymentId,
	payoutId,
	lockTxRef,
	releaseTxRef,
	wrongKeyAccept: {
		httpStatus: wrong.status,
		code: wrong.body.code ?? null,
		messageSafe: typeof wrong.body.message === "string",
		paymentStatusAfter: afterWrong.body.status,
		releaseTxRefAfter: settleWrong?.releaseTxRef ?? null,
		claimNotAccepted: true,
	},
	restoredKeyAccept: {
		httpStatus: accepted.status,
		paymentStatus: afterOk.body.status,
		samePayoutId: true,
		releaseTxRef,
	},
	notes: [
		"Seal keys generated for this run only; never logged or committed.",
		"Claim token kept under /tmp/fp-e1-private only; deleted after evidence write.",
		"Baseline vault used (H2 is seal custody, not anchor asset).",
	],
	completedAt: new Date().toISOString(),
};

const outPath = resolve(evidenceDir, "2026-10-25-h2-seal-key-negative.md");
writeFileSync(
	outPath,
	`# H2 — different-seal-key negative control (25 Oct 2026)

**Status: PASS** (isolated DB + Stellar vault; API restarted between steps)

| Step | Result |
| --- | --- |
| Fund with seal key A | payment \`${paymentId}\` locked; payoutId \`${payoutId}\`; lockTxRef \`${lockTxRef}\` |
| Restart API with **wrong** seal key B; accept same claim | HTTP **${wrong.status}** code \`${String(wrong.body.code ?? "")}\`; payment **${String(afterWrong.body.status)}**; **no** \`releaseTxRef\`; claim not accepted |
| Restart API with **original** seal key A; accept **same** claim | payment **paid**; same payoutId; releaseTxRef \`${releaseTxRef}\` |

## Isolation

- Embedded Postgres data dir: \`apps/api/.pgdata-h2-seal\` (port 54341) — not the default demo DB
- Settlement: \`${process.env.FP_SETTLEMENT ?? "stellar"}\` vault \`${publicIds.FP_PAYOUT_VAULT_ID}\`
- No claim token / seal key / secret in this file

## Safety checks

- Wrong-key error body did not include claim token, sealed ciphertext, or env key names
- Wrong-key path did not set \`releaseTxRef\` or mark payment paid

## Machine-readable summary

\`\`\`json
${JSON.stringify(evidence, null, 2)}
\`\`\`
`,
);

writeFileSync(`${privateDir}/h2-result.json`, JSON.stringify(evidence, null, 2));
try {
	const { unlinkSync } = await import("node:fs");
	unlinkSync(`${privateDir}/h2-claim-token.txt`);
} catch {
	/* ignore */
}

await api.stop();
await pg.stop();

console.log(
	`UNLOCK payer+recipientA Cursor H2-seal-negative ${new Date().toISOString()}`,
);
console.log(`H2 PASS evidence → ${outPath}`);
console.log(
	"seal key fingerprints (not secrets):",
	createHash("sha256").update(KEY_A).digest("hex").slice(0, 12),
	"/",
	createHash("sha256").update(KEY_B).digest("hex").slice(0, 12),
);
