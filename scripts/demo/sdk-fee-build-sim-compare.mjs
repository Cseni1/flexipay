/**
 * Simulation-only comparison: legacy sign()-path fee rebuild vs build-once (no fee override).
 * No signing, no submission, no funding, no deployment.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contract } from "@stellar/stellar-sdk";

const REPO = resolve(import.meta.dirname, "../..");
const OUT = resolve(REPO, "scripts/demo/evidence/2026-10-25-sdk-fee-build-sim.json");

function parseEnv(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trimStart().startsWith("#")) continue;
		out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

async function main() {
	const secretsPath = resolve(REPO, "scripts/testnet/.env.secrets");
	const env = {
		...parseEnv(readFileSync(resolve(REPO, "scripts/testnet/testnet-ids.env"), "utf8")),
		...(existsSync(secretsPath) ? parseEnv(readFileSync(secretsPath, "utf8")) : {}),
	};
	const { CustodialDemoWalletProvider } = await import(
		pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/demo-wallets.ts")).href
	);
	const {
		rebuildSorobanTxFeeOnce,
		rebuildSorobanTxFeeLegacyDoubleCount,
		legacySignPathDoubleCountTotal,
		SOROBAN_TX_FEE_UINT32_MAX,
	} = await import(
		pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/vault-tx-fee.ts")).href
	);

	const wallets = CustodialDemoWalletProvider.fromEnv(env);
	const payer = env.FP_PAYER_DEMO_ADDRESS;
	const kp = wallets.keypairForAddress(payer);
	const { signTransaction } = contract.basicNodeSigner(kp, env.FP_STELLAR_NETWORK_PASSPHRASE);
	const client = await contract.Client.from({
		contractId: env.FP_PAYOUT_VAULT_ID,
		rpcUrl: env.FP_STELLAR_RPC_URL,
		networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
		publicKey: payer,
		signTransaction,
	});

	const tx = await client.create_payout({
		payer,
		external_id: randomBytes(32),
		claim_hash: randomBytes(32),
		amount: 19_702_970n,
		mode: { tag: "PayerPays", values: undefined },
		expires_at: BigInt(Math.floor(Date.now() / 1000) + 3600),
	});
	if (tx.simulation?.error) {
		throw new Error(`simulate error: ${tx.simulation.error}`);
	}
	const built = tx.built;
	const sorobanData = tx.simulationData.transactionData;
	const resourceFee = BigInt(sorobanData.resourceFee().toString());
	const assembledFee = BigInt(built.fee);
	const arithLegacy = legacySignPathDoubleCountTotal(assembledFee, resourceFee);

	let legacyRebuild = null;
	try {
		const legacyTx = rebuildSorobanTxFeeLegacyDoubleCount(built, sorobanData, 30);
		legacyRebuild = { ok: true, fee: String(legacyTx.fee) };
	} catch (e) {
		const msg = String(e?.message ?? e);
		const m = /Got (\d+)/.exec(msg);
		legacyRebuild = {
			ok: false,
			errorMessage: msg.slice(0, 300),
			gotFee_fromError: m ? m[1] : null,
			isUint32Overflow: /exceeds the maximum uint32/i.test(msg),
		};
	}

	let onceRebuild = null;
	let discrepancy = null;
	try {
		const onceTx = rebuildSorobanTxFeeOnce(built, sorobanData, 30);
		onceRebuild = { ok: true, fee: String(onceTx.fee) };
		if (BigInt(onceTx.fee) !== assembledFee) {
			discrepancy = {
				severity: "high",
				message:
					"Claude cloneFrom(no fee override) fee != assembled built.fee — do not force; report to Claude",
				assembledFee: String(assembledFee),
				buildOnceFee: String(onceTx.fee),
			};
		}
	} catch (e) {
		onceRebuild = { ok: false, errorMessage: String(e?.message ?? e).slice(0, 300) };
		discrepancy = {
			severity: "high",
			message: "build-once rebuild threw — Claude proposal may not match SDK behavior",
			error: onceRebuild.errorMessage,
		};
	}

	const report = {
		testedAt: new Date().toISOString(),
		noSigning: true,
		noSubmission: true,
		vault: env.FP_PAYOUT_VAULT_ID,
		method: "create_payout",
		latestLedger_rpc: tx.simulation?.latestLedger ?? null,
		minResourceFee_rpc: tx.simulation?.minResourceFee != null ? String(tx.simulation.minResourceFee) : null,
		resourceFee_xdr: String(resourceFee),
		assembledFee_sdk: String(assembledFee),
		arith_legacy_assembled_plus_R: String(arithLegacy),
		legacy_sign_path_rebuild: legacyRebuild,
		build_once_rebuild: onceRebuild,
		uint32_max: String(SOROBAN_TX_FEE_UINT32_MAX),
		legacy_overflows_uint32_arith: arithLegacy > SOROBAN_TX_FEE_UINT32_MAX,
		build_once_fits_uint32:
			onceRebuild?.ok === true ? BigInt(onceRebuild.fee) <= SOROBAN_TX_FEE_UINT32_MAX : null,
		claude_proposal_discrepancy: discrepancy,
		ceiling_note:
			"FP_SOROBAN_TX_FEE_CEILING_STROOPS default not set in this sim; Claude must confirm before writes.",
	};

	mkdirSync(resolve(REPO, "scripts/demo/evidence"), { recursive: true });
	writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
	console.log(JSON.stringify({ wrote: OUT, ...report, claude_proposal_discrepancy: discrepancy }, null, 2));
	if (discrepancy) process.exit(2);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
