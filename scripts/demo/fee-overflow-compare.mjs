/**
 * Read-only fee comparison: deposit vs create_payout.
 * No signAndSend. Never prints secrets / claim secrets / XDR envelopes.
 */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, rpc, xdr } from "@stellar/stellar-sdk";
const Api = rpc.Api;

const REPO = "/Users/csenike/Projects/FlexiPay/flexipay-m2-accept";
const OUT = resolve(REPO, "scripts/demo/evidence/2026-10-25-m2-fee-overflow-compare.json");
const COMMIT = "f5af6669495fa9c243117f0e9896fc2f7e601713";

function parseEnv(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trimStart().startsWith("#")) continue;
		out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

function callNum(obj, names) {
	for (const n of names) {
		try {
			const v = typeof obj[n] === "function" ? obj[n]() : obj[n];
			if (v === undefined || v === null) continue;
			if (typeof v === "function") continue;
			if (typeof v === "bigint" || typeof v === "number" || typeof v === "string")
				return String(v);
		} catch {
			/* try next */
		}
	}
	return null;
}

function footprintCounts(fp) {
	if (!fp) return null;
	try {
		const ro = fp.readOnly?.() ?? fp.readOnly;
		const rw = fp.readWrite?.() ?? fp.readWrite;
		return {
			readOnlyEntries: Array.isArray(ro) ? ro.length : null,
			readWriteEntries: Array.isArray(rw) ? rw.length : null,
		};
	} catch {
		return null;
	}
}

function extractResources(sim) {
	const out = {
		source: "rpc_simulation_fields_and_xdr_accessors",
		minResourceFee_rpc: sim?.minResourceFee != null ? String(sim.minResourceFee) : null,
		latestLedger_rpc: sim?.latestLedger ?? null,
		error_rpc: typeof sim?.error === "string" ? sim.error.slice(0, 240) : null,
		isSimulationSuccess: sim ? Api.isSimulationSuccess(sim) : false,
		isSimulationRestore: sim ? Api.isSimulationRestore(sim) : false,
		isSimulationError: sim ? Api.isSimulationError(sim) : false,
		eventsCount_rpc: Array.isArray(sim?.events) ? sim.events.length : null,
		resultsCount_rpc: Array.isArray(sim?.results) ? sim.results.length : null,
		restorePreamble: null,
		resources: null,
		footprint: null,
		txDataResourceFee_xdr: null,
		eventsSizeBytes_estimate: null,
		returnValueSizeBytes_estimate: null,
	};

	if (sim?.restorePreamble) {
		out.restorePreamble = {
			present: true,
			minResourceFee_rpc:
				sim.restorePreamble.minResourceFee != null
					? String(sim.restorePreamble.minResourceFee)
					: null,
			hasTransactionData: Boolean(sim.restorePreamble.transactionData),
		};
	}

	try {
		const data = sim?.transactionData;
		if (data) {
			const resources = typeof data.resources === "function" ? data.resources() : data.resources;
			out.resources = {
				instructions: callNum(resources, ["instructions"]),
				readBytes: callNum(resources, ["readBytes"]),
				writeBytes: callNum(resources, ["writeBytes"]),
			};
			const fp =
				typeof resources?.footprint === "function"
					? resources.footprint()
					: resources?.footprint;
			out.footprint = footprintCounts(fp);
			out.txDataResourceFee_xdr = callNum(data, ["resourceFee"]);
		}
	} catch (e) {
		out.resourcesExtractError = e instanceof Error ? e.message.slice(0, 160) : String(e);
	}

	// Size estimates from RPC-provided base64 blobs only (not invented fee components)
	try {
		if (Array.isArray(sim?.events)) {
			out.eventsSizeBytes_estimate = sim.events.reduce(
				(n, ev) => n + (typeof ev === "string" ? Buffer.from(ev, "base64").length : JSON.stringify(ev).length),
				0,
			);
		}
		const retval = sim?.result?.retval;
		if (retval && typeof retval.toXDR === "function") {
			out.returnValueSizeBytes_estimate = retval.toXDR().length;
		}
	} catch {
		/* optional */
	}

	return out;
}

async function simulateOnce(client, method, args) {
	const started = Date.now();
	try {
		const tx = await client[method](args);
		const sim = tx.simulation;
		return {
			method,
			ok: true,
			elapsedMs: Date.now() - started,
			builtFee_fromAssembledTx: tx.built?.fee != null ? String(tx.built.fee) : null,
			simulation: extractResources(sim),
			note: "builtFee_fromAssembledTx is post-SDK-assemble of this Client invoke; not independently re-derived here",
		};
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return {
			method,
			ok: false,
			elapsedMs: Date.now() - started,
			errorMessage: msg.slice(0, 400),
			isFeeOverflow: /exceeds the maximum uint32/i.test(msg),
		};
	}
}

async function fetchConfigSettings(server) {
	const ids = [
		["contractComputeV0", xdr.ConfigSettingId.configSettingContractComputeV0()],
		["contractLedgerCostV0", xdr.ConfigSettingId.configSettingContractLedgerCostV0()],
		["stateArchival", xdr.ConfigSettingId.configSettingStateArchival()],
		["contractBandwidthV0", xdr.ConfigSettingId.configSettingContractBandwidthV0()],
		["contractEventsV0", xdr.ConfigSettingId.configSettingContractEventsV0()],
	];
	const keys = ids.map(
		([, id]) => new xdr.LedgerKey({ configSetting: new xdr.LedgerKeyConfigSetting({ configSettingId: id }) }),
	);
	const res = await server.getLedgerEntries(...keys);
	const byName = {};
	for (let i = 0; i < ids.length; i++) {
		const name = ids[i][0];
		const entry = res.entries?.[i];
		if (!entry) {
			byName[name] = { found: false };
			continue;
		}
		try {
			const val = entry.val;
			const cs = typeof val.configSetting === "function" ? val.configSetting() : val.configSetting?.();
			// Prefer structured JSON of known numeric fields when present
			const switchName = cs?.switch?.()?.name ?? cs?._arm ?? null;
			byName[name] = {
				found: true,
				liveUntilLedgerSeq: entry.liveUntilLedgerSeq ?? null,
				lastModifiedLedgerSeq: entry.lastModifiedLedgerSeq ?? null,
				settingArm: switchName,
				// Raw XDR length only — avoid dumping full setting blobs into the PR
				xdrByteLength: entry.val.toXDR ? entry.val.toXDR().length : null,
				source: "rpc_getLedgerEntries",
			};
			// Extract a few well-known numeric fields where accessors exist
			const inner = cs?._value ?? cs;
			if (inner && typeof inner === "object") {
				const nums = {};
				for (const k of Object.keys(inner)) {
					if (k.startsWith("_")) continue;
					const v = callNum(inner, [k]);
					if (v != null && /^\d+$/.test(v)) nums[k] = v;
				}
				if (Object.keys(nums).length) byName[name].numericFields_rpc = nums;
			}
		} catch (e) {
			byName[name] = {
				found: true,
				parseError: e instanceof Error ? e.message.slice(0, 160) : String(e),
			};
		}
	}
	return { latestLedger: res.latestLedger ?? null, settings: byName };
}

function loadEnv() {
	const ids = parseEnv(readFileSync(resolve(REPO, "scripts/testnet/testnet-ids.env"), "utf8"));
	const secrets = parseEnv(readFileSync(resolve(REPO, "scripts/testnet/.env.secrets"), "utf8"));
	return { ...ids, ...secrets };
}

console.log("progress: init…");
const env = loadEnv();
const { CustodialDemoWalletProvider } = await import(
	pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/demo-wallets.ts")).href
);
const { externalIdFor } = await import(
	pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/vault-math.ts")).href
);

const wallets = CustodialDemoWalletProvider.fromEnv(env);
const payer = env.FP_PAYER_DEMO_ADDRESS;
const payerKp = wallets.keypairForAddress(payer);
const { signTransaction } = contract.basicNodeSigner(payerKp, env.FP_STELLAR_NETWORK_PASSPHRASE);
const server = new rpc.Server(env.FP_STELLAR_RPC_URL);
const vault = env.FP_PAYOUT_VAULT_ID;

const client = await contract.Client.from({
	contractId: vault,
	rpcUrl: env.FP_STELLAR_RPC_URL,
	networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
	publicKey: payer,
	signTransaction,
});

const amount = 19702970n;
const fundAmount = amount + (amount * 100n) / 10000n;
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
// Fixed external id for sample stability across ledgers (unused on-chain for pay_b61)
const externalId = externalIdFor("pay_b61ffbace8fe4a8b1397ad38", 1);
const claimHash = randomBytes(32);

const depositArgs = { payer, amount: fundAmount };
const createArgs = {
	payer,
	external_id: externalId,
	claim_hash: claimHash,
	amount,
	mode: { tag: "PayerPays", values: undefined },
	expires_at: expiresAt,
};

console.log("progress: config settings…");
let configSettings;
try {
	configSettings = await fetchConfigSettings(server);
} catch (e) {
	configSettings = {
		error: e instanceof Error ? e.message.slice(0, 300) : String(e),
	};
}

console.log("progress: network…");
const network = await server.getNetwork().catch((e) => ({
	error: e instanceof Error ? e.message.slice(0, 200) : String(e),
}));
const versionInfo = await server.getVersionInfo?.().catch(() => null);

const samples = [];
const SAMPLE_N = 3;
for (let i = 0; i < SAMPLE_N; i++) {
	console.log(`progress: sample ${i + 1}/${SAMPLE_N}…`);
	const ledgerBefore = await server.getLatestLedger().then((l) => l.sequence);
	const deposit = await simulateOnce(client, "deposit", depositArgs);
	const create_payout = await simulateOnce(client, "create_payout", createArgs);
	const ledgerAfter = await server.getLatestLedger().then((l) => l.sequence);
	samples.push({
		sampleIndex: i,
		ledgerBefore,
		ledgerAfter,
		deposit,
		create_payout,
	});
	if (i < SAMPLE_N - 1) {
		// wait for at least one ledger close (~5–6s testnet)
		await new Promise((r) => setTimeout(r, 7000));
	}
}

const report = {
	testedCommit: COMMIT,
	diagnosedAt: new Date().toISOString(),
	noTransactionsSubmitted: true,
	rpcUrl: env.FP_STELLAR_RPC_URL,
	networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
	vault: vault,
	invoker: payer,
	network: {
		friendbotUrl: network?.friendbotUrl ?? null,
		passphrase: network?.passphrase ?? null,
		protocolVersion: network?.protocolVersion ?? null,
		versionInfo: versionInfo
			? {
					version: versionInfo.version ?? null,
					commitHash: versionInfo.commitHash ?? null,
					buildTimeStamp: versionInfo.buildTimeStamp ?? null,
					captiveCoreVersion: versionInfo.captiveCoreVersion ?? null,
					protocolVersion: versionInfo.protocolVersion ?? null,
				}
			: null,
	},
	configSettings,
	argShapeSanitised: {
		deposit: { payer, amount: String(fundAmount) },
		create_payout: {
			payer,
			amount: String(amount),
			mode: "PayerPays",
			expires_at: String(expiresAt),
			external_id_byteLength: 32,
			external_id_sha256_prefix: createHash("sha256").update(externalId).digest("hex").slice(0, 16),
			claim_hash_byteLength: 32,
			claim_hash_note: "random placeholder for sim shape only",
		},
	},
	samples,
	feeArithmeticNote:
		"API observed Got 5261104576 on /fund. This script records RPC minResourceFee and SDK AssembledTransaction.built.fee only. It does NOT invent a breakdown of 5261104576 into components unless those components appear as RPC/SDK fields.",
	comparisonHints: {
		deposit_vs_create_minResourceFee: samples.map((s) => ({
			ledgerBefore: s.ledgerBefore,
			deposit_minRF: s.deposit.simulation?.minResourceFee_rpc ?? null,
			create_minRF: s.create_payout.simulation?.minResourceFee_rpc ?? null,
			deposit_builtFee: s.deposit.builtFee_fromAssembledTx ?? null,
			create_builtFee: s.create_payout.builtFee_fromAssembledTx ?? null,
		})),
	},
};

writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("progress: wrote", OUT);
console.log(
	JSON.stringify(
		{
			samples: report.comparisonHints.deposit_vs_create_minResourceFee,
			configSettingKeys: Object.keys(configSettings?.settings ?? {}),
		},
		null,
		2,
	),
);
