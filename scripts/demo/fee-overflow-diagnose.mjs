/**
 * Read-only fee-overflow diagnosis. No signAndSend / no Horizon submit.
 * Never prints secrets or claim secrets.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, rpc, TransactionBuilder, Account, Networks } from "@stellar/stellar-sdk";

const REPO = "/Users/csenike/Projects/FlexiPay/flexipay-m2-accept";
const PRIVATE = "/tmp/fp-m2-private";
const OUT = resolve(PRIVATE, "fee-overflow-diagnosis.json");
const COMMIT = "f5af6669495fa9c243117f0e9896fc2f7e601713";

function parseEnv(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trimStart().startswith?.("#") || line.trimStart().startsWith("#")) continue;
		out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

function externalIdFor(paymentId, attempt) {
	return createHash("sha256").update(`${paymentId}:${attempt}`, "utf8").digest();
}

function sanitiseArgs(method, args) {
	if (method === "deposit") {
		return {
			payer: args.payer,
			amount: String(args.amount),
			amountNote: "minor units USDC",
		};
	}
	if (method === "create_payout") {
		return {
			payer: args.payer,
			amount: String(args.amount),
			mode: args.mode?.tag ?? args.mode,
			expires_at: String(args.expires_at),
			external_id: {
				byteLength: Buffer.from(args.external_id).length,
				sha256_prefix: createHash("sha256")
					.update(Buffer.from(args.external_id))
					.digest("hex")
					.slice(0, 16),
			},
			claim_hash: {
				byteLength: Buffer.from(args.claim_hash).length,
				// shape only — not the hash value (claim-secret-derived)
				present: true,
			},
		};
	}
	return { keys: Object.keys(args) };
}

function footprintSize(txData) {
	try {
		const fp = txData?.resources?.footprint ?? txData?._attributes?.resources?._attributes?.footprint;
		if (!fp) return null;
		const readOnly = fp.readOnly?.length ?? fp._attributes?.readOnly?.length ?? null;
		const readWrite = fp.readWrite?.length ?? fp._attributes?.readWrite?.length ?? null;
		return { readOnlyEntries: readOnly, readWriteEntries: readWrite };
	} catch {
		return null;
	}
}

function extractSim(tx) {
	const sim = tx.simulation;
	if (!sim) return { hasSimulation: false };
	const out = {
		hasSimulation: true,
		simKind: sim.error
			? "error"
			: sim.restorePreamble
				? "restore"
				: "success_or_other",
		error: typeof sim.error === "string" ? sim.error.slice(0, 400) : null,
		minResourceFee: sim.minResourceFee != null ? String(sim.minResourceFee) : null,
		latestLedger: sim.latestLedger ?? null,
		cost: sim.cost
			? {
					cpuInsns: String(sim.cost.cpuInsns ?? sim.cost.cpu_insns ?? ""),
					memBytes: String(sim.cost.memBytes ?? sim.cost.mem_bytes ?? ""),
				}
			: null,
		restorePreamble: sim.restorePreamble
			? {
					present: true,
					minResourceFee: sim.restorePreamble.minResourceFee != null
						? String(sim.restorePreamble.minResourceFee)
						: null,
					// transactionData presence only
					hasTransactionData: Boolean(sim.restorePreamble.transactionData),
				}
			: null,
	};
	try {
		const data = tx.simulationData?.transactionData;
		if (data) {
			const resources = data.resources?.() ?? data.resources;
			const rd = resources?.readBytes ?? resources?._attributes?.readBytes;
			const wr = resources?.writeBytes ?? resources?._attributes?.writeBytes;
			const ins = resources?.instructions ?? resources?._attributes?.instructions;
			out.resources = {
				instructions: ins != null ? String(ins) : null,
				readBytes: rd != null ? String(rd) : null,
				writeBytes: wr != null ? String(wr) : null,
			};
			out.footprint = footprintSize(data);
			const rf = data.resourceFee?.() ?? data.resourceFee ?? data._attributes?.resourceFee;
			out.txDataResourceFee = rf != null ? String(rf) : null;
		}
	} catch (e) {
		out.simulationDataError = e instanceof Error ? e.message.slice(0, 200) : String(e);
	}
	return out;
}

async function simulateMethod(client, method, args) {
	const started = Date.now();
	try {
		const tx = await client[method](args);
		const sim = extractSim(tx);
		// Attempt assemble/build fee path without signing/sending
		let assemble = { ok: true };
		try {
			if (tx.built) {
				const fee = tx.built.fee ?? tx.built._attributes?.fee;
				assemble.builtFee = fee != null ? String(fee) : null;
			}
		} catch (e) {
			assemble = {
				ok: false,
				error: e instanceof Error ? e.message.slice(0, 300) : String(e),
			};
		}
		return {
			method,
			ok: true,
			elapsedMs: Date.now() - started,
			argsSanitised: sanitiseArgs(method, args),
			simulation: sim,
			assemble,
		};
	} catch (e) {
		return {
			method,
			ok: false,
			elapsedMs: Date.now() - started,
			argsSanitised: sanitiseArgs(method, args),
			errorName: e instanceof Error ? e.name : typeof e,
			errorMessage: e instanceof Error ? e.message.slice(0, 500) : String(e).slice(0, 500),
			isFeeOverflow: /exceeds the maximum uint32/i.test(
				e instanceof Error ? e.message : String(e),
			),
		};
	}
}

function loadMergedEnv() {
	const ids = parseEnv(readFileSync(resolve(REPO, "scripts/testnet/testnet-ids.env"), "utf8"));
	const secretsPath = resolve(REPO, "scripts/testnet/.env.secrets");
	const secrets = existsSync(secretsPath) ? parseEnv(readFileSync(secretsPath, "utf8")) : {};
	return { ...ids, ...secrets };
}

async function makeClient(env, contractId, publicKey, signTransaction) {
	return contract.Client.from({
		contractId,
		rpcUrl: env.FP_STELLAR_RPC_URL,
		networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
		publicKey,
		...(signTransaction ? { signTransaction } : {}),
	});
}

async function horizonTx(hash) {
	const url = `https://horizon-testnet.stellar.org/transactions/${hash}`;
	const ctrl = AbortSignal.timeout(20_000);
	try {
		const res = await fetch(url, { signal: ctrl });
		if (!res.ok) return { hash, http: res.status, found: false };
		const body = await res.json();
		return {
			hash,
			found: true,
			successful: body.successful === true,
			ledger: body.ledger,
			created_at: body.created_at,
			operation_count: body.operation_count,
			fee_charged: body.fee_charged,
			memo: body.memo ?? null,
		};
	} catch (e) {
		return {
			hash,
			found: false,
			error: e instanceof Error ? e.message.slice(0, 120) : String(e),
		};
	}
}

const env = loadMergedEnv();
const { CustodialDemoWalletProvider } = await import(
	pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/demo-wallets.ts")).href
);
const { externalIdFor: extId } = await import(
	pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/vault-math.ts")).href
);

const wallets = CustodialDemoWalletProvider.fromEnv(env);
const payer = env.FP_PAYER_DEMO_ADDRESS;
const payerKp = wallets.keypairForAddress(payer);
const { signTransaction } = contract.basicNodeSigner(
	payerKp,
	env.FP_STELLAR_NETWORK_PASSPHRASE,
);

const baselineVault = env.FP_PAYOUT_VAULT_ID;
const server = new rpc.Server(env.FP_STELLAR_RPC_URL, { allowHttp: false });

console.log("progress: load ledger + clients…");
const latestLedger = await server.getLatestLedger().then((l) => l.sequence).catch(() => null);

const reader = await makeClient(env, baselineVault, payer);
const writer = await makeClient(env, baselineVault, payer, signTransaction);

// Planned amounts from failed M2 payments (USDC minor units)
const amount = 19702970n; // settle amountIn from failed payments
const fundAmount = amount + (amount * 100n) / 10000n; // PayerPays + 100 bps

console.log("progress: read vault balance…");
let vaultBalance = null;
try {
	const balTx = await reader.balance({ payer });
	vaultBalance = String(balTx.result ?? balTx);
} catch (e) {
	vaultBalance = {
		error: e instanceof Error ? e.message.slice(0, 200) : String(e),
	};
}

console.log("progress: simulate deposit (no send)…");
const depositSim = await simulateMethod(writer, "deposit", {
	payer,
	amount: fundAmount,
});

console.log("progress: simulate create_payout (no send)…");
const paymentId = "pay_b61ffbace8fe4a8b1397ad38"; // failed fund attempt (attempt 1)
const attempt = 1;
const externalId = extId(paymentId, attempt);
const claimHash = randomBytes(32); // placeholder shape only — not a real claim secret hash from DB
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
const createPayoutSim = await simulateMethod(writer, "create_payout", {
	payer,
	external_id: externalId,
	claim_hash: claimHash,
	amount,
	mode: { tag: "PayerPays", values: undefined },
	expires_at: expiresAt,
});

console.log("progress: payoutByExternal lookups…");
async function payoutByExternal(pid, att) {
	const eid = extId(pid, att);
	try {
		const tx = await reader.payout_by_external({
			payer,
			external_id: eid,
		});
		const r = tx.result;
		return {
			paymentId: pid,
			attempt: att,
			externalIdSha256Prefix: createHash("sha256").update(eid).digest("hex").slice(0, 16),
			payoutId:
				r === undefined || r === null
					? null
					: typeof r === "bigint"
						? r.toString()
						: String(r?.unwrap?.() ?? r),
		};
	} catch (e) {
		return {
			paymentId: pid,
			attempt: att,
			error: e instanceof Error ? e.message.slice(0, 200) : String(e),
		};
	}
}

const payoutLookups = [];
for (const [pid, att] of [
	["pay_b61ffbace8fe4a8b1397ad38", 1],
	["pay_a2549b830509f79e16b28a60", 1],
	["pay_e23930ba5e5ae5febb244688", 1],
	["pay_6978ce37f9273afe7b4ce3c7", 1],
	["pay_3b65e248d97f1f458830b8af", 1],
]) {
	payoutLookups.push(await payoutByExternal(pid, att));
}

console.log("progress: horizon prior lock txs…");
const priorLocks = [
	"ac28835f3829513ad4c54b68640bdbe2ebba223d387a82d8df2116b2004f6aa7",
	"7638a08d96985bf92055921791690332622a7acb2820dbc167f1e563c8b5d20c",
];
const lockTxHorizon = [];
for (const h of priorLocks) lockTxHorizon.push(await horizonTx(h));

// M1 anchor vault #2 read-only simulate
console.log("progress: M1 anchor vault simulate…");
const anchorIdsPath = resolve(REPO, "scripts/testnet/testnet-ids-anchor-vault.env");
const anchorIds = parseEnv(readFileSync(anchorIdsPath, "utf8"));
const anchorVault = anchorIds.FP_ANCHOR_VAULT_ID;
const anchorAmount = 1_0000000n; // 1 USDC planned (matches E1 evidence scale)
let m1 = { vault: anchorVault, skipped: false };
try {
	const m1Writer = await makeClient(env, anchorVault, payer, signTransaction);
	// balance on anchor vault
	let m1Bal = null;
	try {
		const m1Reader = await makeClient(env, anchorVault, payer);
		const b = await m1Reader.balance({ payer });
		m1Bal = String(b.result ?? b);
	} catch (e) {
		m1Bal = { error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
	}
	const m1Deposit = await simulateMethod(m1Writer, "deposit", {
		payer,
		amount: anchorAmount + (anchorAmount * 100n) / 10000n,
	});
	const m1Create = await simulateMethod(m1Writer, "create_payout", {
		payer,
		external_id: extId("m1_sim_only_no_payment", 1),
		claim_hash: randomBytes(32),
		amount: anchorAmount,
		mode: { tag: "PayerPays", values: undefined },
		expires_at: expiresAt,
	});
	m1 = {
		vault: anchorVault,
		asset: anchorIds.FP_ANCHOR_USDC_ASSET,
		plannedAmountMinor: String(anchorAmount),
		payerVaultBalance: m1Bal,
		depositSim: m1Deposit,
		createPayoutSim: m1Create,
	};
} catch (e) {
	m1 = {
		vault: anchorVault,
		error: e instanceof Error ? e.message.slice(0, 300) : String(e),
	};
}

const failingStage =
	depositSim.isFeeOverflow || (depositSim.ok === false && /uint32/i.test(depositSim.errorMessage || ""))
		? "deposit"
		: createPayoutSim.isFeeOverflow ||
			  (createPayoutSim.ok === false && /uint32/i.test(createPayoutSim.errorMessage || ""))
			? "create_payout"
			: depositSim.ok === false
				? "deposit_other_error"
				: createPayoutSim.ok === false
					? "create_payout_other_error"
					: "neither_threw_on_client_invoke_check_assemble";

const report = {
	testedCommit: COMMIT,
	diagnosedAt: new Date().toISOString(),
	networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
	rpcUrl: env.FP_STELLAR_RPC_URL,
	baselineVault: baselineVault,
	invoker: payer,
	latestLedger,
	failingStage,
	planned: {
		paymentIdSample: paymentId,
		attempt: 1,
		settleAmountMinor: String(amount),
		fundAmountMinor: String(fundAmount),
		feeMode: "PayerPays",
		feeBps: 100,
	},
	payerVaultBalanceMinor: vaultBalance,
	simulations: {
		deposit: depositSim,
		create_payout: createPayoutSim,
	},
	payoutByExternal: payoutLookups,
	priorLockTxHorizon: lockTxHorizon,
	m1AnchorVault: m1,
	notes: [
		"No transactions submitted by this script.",
		"claim_hash in sims is a random 32-byte placeholder for shape-only simulation (not a real claim secret).",
		"external_id uses sha256(paymentId:attempt) for real payment ids where listed.",
	],
};

writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("progress: wrote", OUT);
console.log(
	JSON.stringify(
		{
			failingStage,
			depositOk: depositSim.ok,
			depositFeeOverflow: depositSim.isFeeOverflow ?? false,
			createOk: createPayoutSim.ok,
			createFeeOverflow: createPayoutSim.isFeeOverflow ?? false,
			depositMinResourceFee: depositSim.simulation?.minResourceFee ?? null,
			createMinResourceFee: createPayoutSim.simulation?.minResourceFee ?? null,
			vaultBalance,
			latestLedger,
		},
		null,
		2,
	),
);
