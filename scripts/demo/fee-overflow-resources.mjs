/** Read-only: deposit vs create_payout resource/rent fields + config settings. No submit. */
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, rpc, xdr } from "@stellar/stellar-sdk";

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

function numericMethods(obj) {
	const nums = {};
	const proto = Object.getPrototypeOf(obj);
	for (const name of Object.getOwnPropertyNames(proto)) {
		if (name === "constructor") continue;
		try {
			const v = obj[name]();
			if (typeof v === "number" || typeof v === "bigint") nums[name] = String(v);
		} catch {
			/* skip */
		}
	}
	return nums;
}

async function probe(client, method, args) {
	const tx = await client[method](args);
	const sim = tx.simulation;
	const built = sim.transactionData.build();
	const res = built.resources();
	const fp = res.footprint();
	return {
		method,
		source: "rpc_simulate_via_contract_Client",
		latestLedger_rpc: sim.latestLedger,
		minResourceFee_rpc: String(sim.minResourceFee),
		resourceFee_xdr: String(built.resourceFee()),
		builtFee_assembledTx: String(tx.built.fee),
		restorePreamble_present: Boolean(sim.restorePreamble?.transactionData),
		restorePreamble_minResourceFee_rpc: sim.restorePreamble?.minResourceFee != null
			? String(sim.restorePreamble.minResourceFee)
			: null,
		resources_xdr: numericMethods(res),
		footprint_xdr: {
			readOnlyEntries: fp.readOnly().length,
			readWriteEntries: fp.readWrite().length,
		},
		eventsCount_rpc: Array.isArray(sim.events) ? sim.events.length : null,
		eventsSizeBytes_estimate: Array.isArray(sim.events)
			? sim.events.reduce(
					(n, ev) =>
						n +
						(typeof ev === "string"
							? Buffer.from(ev, "base64").length
							: JSON.stringify(ev).length),
					0,
				)
			: null,
		returnValueSizeBytes_estimate:
			sim.result?.retval && typeof sim.result.retval.toXDR === "function"
				? sim.result.retval.toXDR().length
				: null,
		stateChanges_rpc: Array.isArray(sim.stateChanges)
			? {
					count: sim.stateChanges.length,
					types: sim.stateChanges.map((c) => c.type ?? null),
				}
			: null,
	};
}

async function configBundle(server) {
	const specs = [
		["contractComputeV0", xdr.ConfigSettingId.configSettingContractComputeV0()],
		["contractLedgerCostV0", xdr.ConfigSettingId.configSettingContractLedgerCostV0()],
		["stateArchival", xdr.ConfigSettingId.configSettingStateArchival()],
		["contractBandwidthV0", xdr.ConfigSettingId.configSettingContractBandwidthV0()],
		["contractEventsV0", xdr.ConfigSettingId.configSettingContractEventsV0()],
	];
	const out = {};
	for (const [name, id] of specs) {
		const key = xdr.LedgerKey.configSetting(
			new xdr.LedgerKeyConfigSetting({ configSettingId: id }),
		);
		const res = await server.getLedgerEntries(key);
		const entry = res.entries?.[0];
		if (!entry) {
			out[name] = { found: false };
			continue;
		}
		const cs = entry.val.configSetting();
		const arm = cs.switch()?.name ?? null;
		// Call the matching accessor if present (e.g. contractLedgerCost)
		let inner = null;
		for (const candidate of [
			arm,
			arm?.replace(/V0$/, ""),
			"contractCompute",
			"contractLedgerCost",
			"stateArchival",
			"contractBandwidth",
			"contractEvents",
		]) {
			if (!candidate || typeof cs[candidate] !== "function") continue;
			try {
				inner = cs[candidate]();
				break;
			} catch {
				/* try next */
			}
		}
		out[name] = {
			found: true,
			source: "rpc_getLedgerEntries",
			latestLedger: res.latestLedger,
			settingArm: arm,
			numericFields_rpc: inner ? numericMethods(inner) : {},
		};
	}
	return out;
}

console.log("progress: init");
const env = {
	...parseEnv(readFileSync(resolve(REPO, "scripts/testnet/testnet-ids.env"), "utf8")),
	...parseEnv(readFileSync(resolve(REPO, "scripts/testnet/.env.secrets"), "utf8")),
};
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
const client = await contract.Client.from({
	contractId: env.FP_PAYOUT_VAULT_ID,
	rpcUrl: env.FP_STELLAR_RPC_URL,
	networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
	publicKey: payer,
	signTransaction,
});

const amount = 19702970n;
const fundAmount = amount + (amount * 100n) / 10000n;
const expiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);
const externalId = externalIdFor("pay_b61ffbace8fe4a8b1397ad38", 1);
const depositArgs = { payer, amount: fundAmount };
const createArgs = {
	payer,
	external_id: externalId,
	claim_hash: randomBytes(32),
	amount,
	mode: { tag: "PayerPays", values: undefined },
	expires_at: expiresAt,
};

console.log("progress: config settings");
const configSettings = await configBundle(server);

const samples = [];
for (let i = 0; i < 3; i++) {
	console.log(`progress: sample ${i + 1}/3`);
	const ledgerBefore = (await server.getLatestLedger()).sequence;
	const deposit = await probe(client, "deposit", depositArgs);
	const create_payout = await probe(client, "create_payout", createArgs);
	samples.push({ sampleIndex: i, ledgerBefore, deposit, create_payout });
	if (i < 2) await new Promise((r) => setTimeout(r, 7000));
}

const report = {
	testedCommit: COMMIT,
	diagnosedAt: new Date().toISOString(),
	noTransactionsSubmitted: true,
	vault: env.FP_PAYOUT_VAULT_ID,
	invoker: payer,
	rpcUrl: env.FP_STELLAR_RPC_URL,
	argShapeSanitised: {
		deposit: { amount: String(fundAmount) },
		create_payout: {
			amount: String(amount),
			mode: "PayerPays",
			external_id_sha256_prefix: createHash("sha256")
				.update(externalId)
				.digest("hex")
				.slice(0, 16),
			claim_hash: "random_32_bytes_placeholder_not_api_claim_hash",
			expires_at: String(expiresAt),
		},
	},
	configSettings_rpc: configSettings,
	samples,
	apiObservedOverflowTotal: {
		value: "5261104576",
		source: "API_error_message_only",
		note: "Not decomposed here. Script records RPC minResourceFee and AssembledTransaction.built.fee only.",
	},
	inputDifferencesVsApi: [
		"API claim_hash comes from sealed claim secret; this script uses a random 32-byte placeholder",
		"API expires_at comes from runtime lockExpiresAt / quote window; script uses now+3600s",
		"API runs deposit then create_payout sequentially in one fundAndRun; script simulates each independently",
		"API may re-simulate inside signAndSend; script does not call signAndSend",
	],
};

writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log("progress: wrote", OUT);
console.log(
	JSON.stringify(
		samples.map((s) => ({
			ledger: s.ledgerBefore,
			dep_minRF: s.deposit.minResourceFee_rpc,
			dep_ins: s.deposit.resources_xdr.instructions,
			dep_write: s.deposit.resources_xdr.writeBytes,
			cr_minRF: s.create_payout.minResourceFee_rpc,
			cr_ins: s.create_payout.resources_xdr.instructions,
			cr_write: s.create_payout.resources_xdr.writeBytes,
			cr_state: s.create_payout.stateChanges_rpc,
		})),
		null,
		2,
	),
);
