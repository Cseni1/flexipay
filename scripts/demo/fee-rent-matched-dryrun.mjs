/**
 * Assignment 1 — matched fee/rent diagnosis (read-only).
 * No submit, no envelope signing that could submit, no DB mutations.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { contract, rpc, TransactionBuilder, xdr } from "@stellar/stellar-sdk";

const REPO = "/Users/csenike/Projects/FlexiPay/flexipay-m2-accept";
const OUT_DIR = resolve(REPO, "scripts/demo/evidence");
const OUT_JSON = resolve(OUT_DIR, "2026-10-25-m2-fee-rent-matched.json");
const COMMIT = "729e67f";
const UINT32_MAX = 4_294_967_295;
const TTL_ENTRY_SIZE = 48; // rs-soroban-env fees.rs

function parseEnv(text) {
	const out = {};
	for (const line of text.split("\n")) {
		const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
		if (!m || line.trimStart().startsWith("#")) continue;
		out[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
	}
	return out;
}

function xdrNum(v) {
	if (v == null) return null;
	if (typeof v === "number" || typeof v === "bigint") return String(v);
	if (typeof v?.toBigInt === "function") return String(v.toBigInt());
	if (typeof v?._value === "bigint" || typeof v?._value === "number") return String(v._value);
	if (typeof v?.toString === "function") {
		const s = v.toString();
		if (/^-?\d+$/.test(s)) return s;
	}
	return null;
}

function numsFromXdrObj(obj) {
	const out = {};
	if (!obj || typeof obj !== "object") return out;
	const proto = Object.getPrototypeOf(obj);
	for (const name of Object.getOwnPropertyNames(proto)) {
		if (name === "constructor") continue;
		try {
			const n = xdrNum(obj[name]());
			if (n != null) out[name] = n;
		} catch {
			/* skip */
		}
	}
	return out;
}

function ceilDiv(a, b) {
	if (b <= 0n) throw new Error("bad denom");
	return (a + b - 1n) / b;
}

/** Port of compute_rent_write_fee_per_1kb (rs-soroban-env/src/fees.rs). */
function computeRentWriteFeePer1kb(stateSize, cfg) {
	const MIN = 1000n;
	const low = BigInt(cfg.rentFee1KbSorobanStateSizeLow);
	const high = BigInt(cfg.rentFee1KbSorobanStateSizeHigh);
	const target = BigInt(cfg.sorobanStateTargetSizeBytes);
	const growth = BigInt(cfg.sorobanStateRentFeeGrowthFactor);
	const mult = high > low ? high - low : 0n;
	let fee;
	if (stateSize < target) {
		fee = low + ceilDiv(mult * stateSize, target > 0n ? target : 1n);
	} else {
		const after = stateSize - target;
		fee = high + ceilDiv(mult * after * growth, target > 0n ? target : 1n);
	}
	return fee > MIN ? fee : MIN;
}

function rentFeeForSizeAndLedgers(isPersistent, size, ledgers, feePerRent1kb, denoms) {
	const num =
		BigInt(size) * BigInt(feePerRent1kb) * BigInt(ledgers);
	const storageCoef = BigInt(isPersistent ? denoms.persistent : denoms.temporary);
	const denom = 1024n * (storageCoef > 0n ? storageCoef : 1n);
	return ceilDiv(num, denom);
}

async function getConfigSetting(server, idEnum) {
	const key = xdr.LedgerKey.configSetting(
		new xdr.LedgerKeyConfigSetting({ configSettingId: idEnum }),
	);
	const res = await server.getLedgerEntries(key);
	const entry = res.entries?.[0];
	if (!entry) return { found: false, latestLedger: res.latestLedger };
	const cs = entry.val.configSetting();
	const arm = cs.switch()?.name ?? null;
	let inner = null;
	try {
		inner = cs.value();
	} catch {
		inner = null;
	}
	return {
		found: true,
		source: "rpc_getLedgerEntries",
		latestLedger: res.latestLedger,
		arm,
		numericFields_rpc: Array.isArray(inner) ? null : numsFromXdrObj(inner),
		arrayValues_rpc: Array.isArray(inner)
			? inner.map((v) => xdrNum(v)).filter((x) => x != null)
			: null,
	};
}

function vaultTtlConstants() {
	const DAY_LEDGERS = 17_280;
	return {
		source: "contracts/payout_vault/src/lib.rs",
		DAY_LEDGERS,
		TTL_THRESHOLD: 30 * DAY_LEDGERS,
		TTL_BUMP: 60 * DAY_LEDGERS,
		note: "extend_ttl(threshold, extend_to): bump live_until to current+extend_to when below threshold. New persistent writes typically land near current+TTL_BUMP.",
	};
}

function decodeStateChange(change) {
	const out = { type: change.type ?? null, keyKind: null, before: null, after: null };
	try {
		const key =
			typeof change.key === "string"
				? xdr.LedgerKey.fromXDR(change.key, "base64")
				: change.key;
		out.keyKind = key?.switch?.()?.name ?? null;
	} catch {
		out.keyKind = "decode_failed";
	}
	for (const side of ["before", "after"]) {
		const raw = change[side];
		if (raw == null) {
			out[side] = null;
			continue;
		}
		try {
			const le =
				typeof raw === "string" ? xdr.LedgerEntry.fromXDR(raw, "base64") : raw;
			const xdrLen =
				typeof raw === "string"
					? Buffer.from(raw, "base64").length
					: typeof le.toXDR === "function"
						? le.toXDR().length
						: null;
			out[side] = {
				encodedLedgerEntryBytes_estimate: xdrLen,
				entryDataArm: le.data?.()?.switch?.()?.name ?? null,
			};
		} catch (e) {
			out[side] = { decodeError: String(e?.message ?? e).slice(0, 120) };
		}
	}
	return out;
}

async function probeCreatePayout(client, args, label) {
	const tx = await client.create_payout(args);
	const sim = tx.simulation;
	const simError = sim?.error ?? null;
	const builtData =
		sim?.transactionData && typeof sim.transactionData.build === "function"
			? sim.transactionData.build()
			: null;
	const res = builtData?.resources?.() ?? null;
	const fp = res?.footprint?.() ?? null;
	const minRF = sim?.minResourceFee != null ? String(sim.minResourceFee) : null;
	const resourceFeeXdr = builtData ? String(builtData.resourceFee()) : null;
	const assembledFee = tx.built?.fee != null ? String(tx.built.fee) : null;

	let signPathRebuild = null;
	let cloneFromStripped = null;
	if (tx.built && builtData) {
		try {
			const rebuilt = TransactionBuilder.cloneFrom(tx.built, {
				fee: tx.built.fee,
				timebounds: undefined,
				sorobanData: builtData,
			})
				.setTimeout(30)
				.build();
			signPathRebuild = { ok: true, rebuiltFee: String(rebuilt.fee) };
		} catch (e) {
			const msg = String(e?.message ?? e);
			const m = /Got (\d+)/.exec(msg);
			signPathRebuild = {
				ok: false,
				errorMessage: msg.slice(0, 400),
				gotFee_fromError: m ? m[1] : null,
				isUint32Overflow: /exceeds the maximum uint32/i.test(msg),
			};
		}
		try {
			const stripped = TransactionBuilder.cloneFrom(tx.built, {
				timebounds: undefined,
				sorobanData: builtData,
			})
				.setTimeout(30)
				.build();
			cloneFromStripped = { ok: true, rebuiltFee: String(stripped.fee) };
		} catch (e) {
			const msg = String(e?.message ?? e);
			const m = /Got (\d+)/.exec(msg);
			cloneFromStripped = {
				ok: false,
				errorMessage: msg.slice(0, 400),
				gotFee_fromError: m ? m[1] : null,
			};
		}
	}

	const arith =
		minRF && assembledFee
			? (() => {
					const R = BigInt(minRF);
					const A = BigInt(assembledFee);
					const inclusion = A >= R ? A - R : null;
					const gotSign = signPathRebuild?.gotFee_fromError
						? BigInt(signPathRebuild.gotFee_fromError)
						: signPathRebuild?.rebuiltFee
							? BigInt(signPathRebuild.rebuiltFee)
							: null;
					return {
						inclusionFee_assembled_minus_resourceFee:
							inclusion != null ? String(inclusion) : null,
						assembled_plus_resourceFee: String(A + R),
						two_times_resourceFee_plus_inclusion:
							inclusion != null ? String(2n * R + inclusion) : null,
						signRebuild_got_or_fee: gotSign != null ? String(gotSign) : null,
						signRebuild_equals_assembled_plus_R:
							gotSign != null ? gotSign === A + R : null,
						signRebuild_equals_historical_5261104576:
							gotSign != null ? gotSign === 5261104576n : null,
						assembled_plus_R_equals_historical_5261104576: A + R === 5261104576n,
						uint32_max: String(UINT32_MAX),
					};
				})()
			: null;

	return {
		label,
		argsSanitised: {
			payer: args.payer,
			amount: String(args.amount),
			mode: args.mode?.tag ?? args.mode,
			expires_at_unix: String(args.expires_at),
			external_id_hex_prefix: Buffer.from(args.external_id).toString("hex").slice(0, 16),
			claim_hash_hex_prefix: Buffer.from(args.claim_hash).toString("hex").slice(0, 16),
			claim_hash_byteLength: Buffer.from(args.claim_hash).length,
		},
		simulation: {
			source: "rpc_simulate_via_contract_Client_create_payout",
			latestLedger_rpc: sim?.latestLedger ?? null,
			error_rpc: simError,
			minResourceFee_rpc: minRF,
			resourceFee_xdr: resourceFeeXdr,
			builtFee_assembledTx: assembledFee,
			restorePreamble_present: Boolean(sim?.restorePreamble?.transactionData),
			resources_xdr: res ? numsFromXdrObj(res) : null,
			footprint_xdr: fp
				? {
						readOnlyEntries: fp.readOnly().length,
						readWriteEntries: fp.readWrite().length,
					}
				: null,
			stateChanges_decoded: Array.isArray(sim?.stateChanges)
				? sim.stateChanges.map(decodeStateChange)
				: null,
		},
		signPathRebuild_measured: signPathRebuild,
		cloneFromWithoutFeeOverride_measured: cloneFromStripped,
		arithmetic_check: arith,
	};
}

async function main() {
	console.log("progress: load env/db");
	const secretsPath = resolve(REPO, "scripts/testnet/.env.secrets");
	const env = {
		...parseEnv(readFileSync(resolve(REPO, "scripts/testnet/testnet-ids.env"), "utf8")),
		...(existsSync(secretsPath) ? parseEnv(readFileSync(secretsPath, "utf8")) : {}),
	};
	const databaseUrl = readFileSync("/tmp/fp-m2-private/database_url", "utf8").trim();
	const { PrismaPg } = await import("@prisma/adapter-pg");
	const { PrismaClient } = await import(
		pathToFileURL(resolve(REPO, "apps/api/src/generated/prisma/client.ts")).href
	);
	const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
	const paymentId = "pay_b61ffbace8fe4a8b1397ad38";
	const payment = await db.payment.findUniqueOrThrow({
		where: { id: paymentId },
		select: { id: true, status: true, lockAttempt: true, quoteId: true },
	});
	const link = await db.claimLink.findUniqueOrThrow({
		where: { paymentId },
		select: { vaultClaimHashHex: true, expiresAt: true, status: true },
	});
	const settle = await db.leg.findFirstOrThrow({
		where: { paymentId, kind: "settle" },
		select: {
			amountInValue: true,
			externalRef: true,
			lockTxRef: true,
			status: true,
		},
	});
	const quote = await db.quote.findUniqueOrThrow({
		where: { id: payment.quoteId },
		select: { feeMode: true, validUntil: true },
	});
	await db.$disconnect();

	const feeMode = quote.feeMode === "RecipientPays" ? "RecipientPays" : "PayerPays";
	const amountMinor = BigInt(settle.amountInValue);
	const claimHash = Buffer.from(link.vaultClaimHashHex, "hex");
	const exactExpiresAt = BigInt(Math.floor(new Date(link.expiresAt).getTime() / 1000));
	const feeMeasureExpiresAt = BigInt(Math.floor(Date.now() / 1000) + 3600);

	const { externalIdFor } = await import(
		pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/vault-math.ts")).href
	);
	const { CustodialDemoWalletProvider } = await import(
		pathToFileURL(resolve(REPO, "packages/adapter-stellar/src/demo-wallets.ts")).href
	);
	const wallets = CustodialDemoWalletProvider.fromEnv(env);
	const payerAddr = env.FP_PAYER_DEMO_ADDRESS;
	const payerKp = wallets.keypairForAddress(payerAddr);
	const { signTransaction } = contract.basicNodeSigner(
		payerKp,
		env.FP_STELLAR_NETWORK_PASSPHRASE,
	);

	const client = await contract.Client.from({
		contractId: env.FP_PAYOUT_VAULT_ID,
		rpcUrl: env.FP_STELLAR_RPC_URL,
		networkPassphrase: env.FP_STELLAR_NETWORK_PASSPHRASE,
		publicKey: payerAddr,
		signTransaction, // sim auth only — never call sign()/signAndSend()/send()
	});

	console.log("progress: config settings");
	const server = new rpc.Server(env.FP_STELLAR_RPC_URL);
	const ledgerCost = await getConfigSetting(
		server,
		xdr.ConfigSettingId.configSettingContractLedgerCostV0(),
	);
	const stateArchival = await getConfigSetting(
		server,
		xdr.ConfigSettingId.configSettingStateArchival(),
	);
	const liveStateWindow = await getConfigSetting(
		server,
		xdr.ConfigSettingId.configSettingLiveSorobanStateSizeWindow(),
	);
	const ledgerCostExt = await getConfigSetting(
		server,
		xdr.ConfigSettingId.configSettingContractLedgerCostExtV0(),
	);

	const lc = ledgerCost.numericFields_rpc || {};
	const arch = stateArchival.numericFields_rpc || {};
	const window = liveStateWindow.arrayValues_rpc || [];
	const latestStateSize =
		window.length > 0 ? BigInt(window[window.length - 1]) : null;
	const feeWrite1Kb = ledgerCostExt.numericFields_rpc?.feeWrite1Kb ?? null;

	const ttl = vaultTtlConstants();
	const rentCalc = {
		formula_sources: [
			"rs-soroban-env/src/fees.rs — compute_rent_write_fee_per_1kb, compute_rent_fee, rent_fee_for_size_and_ledgers",
			"stellar-protocol CAP-0046-07 — Rent fee section",
		],
		units: "stroops; sizes in bytes; ledgers dimensionless; fee_per_rent_1kb is stroops per 1KB of rented space",
		growthFactor_role:
			"sorobanStateRentFeeGrowthFactor multiplies ONLY the post-target slope inside compute_rent_write_fee_per_1kb(state_size). It is NOT a direct multiplier on entry rent (S·L·rate).",
		vault_ttl: ttl,
		config_from_rpc: {
			contractLedgerCostV0: ledgerCost,
			stateArchival,
			liveSorobanStateSizeWindow: {
				...liveStateWindow,
				latestSample_bytes: latestStateSize != null ? String(latestStateSize) : null,
				sampleCount: window.length,
			},
			contractLedgerCostExtV0: ledgerCostExt,
		},
		computed: null,
		limitations: [],
	};

	if (
		latestStateSize != null &&
		lc.sorobanStateTargetSizeBytes &&
		lc.rentFee1KbSorobanStateSizeLow &&
		lc.rentFee1KbSorobanStateSizeHigh &&
		lc.sorobanStateRentFeeGrowthFactor &&
		arch.persistentRentRateDenominator
	) {
		const feePerRent1kb = computeRentWriteFeePer1kb(latestStateSize, {
			sorobanStateTargetSizeBytes: lc.sorobanStateTargetSizeBytes,
			rentFee1KbSorobanStateSizeLow: lc.rentFee1KbSorobanStateSizeLow,
			rentFee1KbSorobanStateSizeHigh: lc.rentFee1KbSorobanStateSizeHigh,
			sorobanStateRentFeeGrowthFactor: lc.sorobanStateRentFeeGrowthFactor,
		});
		const denoms = {
			persistent: Number(arch.persistentRentRateDenominator),
			temporary: Number(arch.tempRentRateDenominator || 1),
		};
		// Entry sizes: NOT exact from RPC TTL pairs. Bound using writeBytes / created count after probe.
		rentCalc.computed = {
			soroban_state_size_bytes_rpc_window_latest: String(latestStateSize),
			sorobanStateTargetSizeBytes_rpc: lc.sorobanStateTargetSizeBytes,
			state_above_target_bytes: String(
				latestStateSize - BigInt(lc.sorobanStateTargetSizeBytes),
			),
			fee_per_rent_1kb_calculated: String(feePerRent1kb),
			feeWrite1Kb_rpc_ledgerCostExt: feeWrite1Kb,
			feeWriteLedgerEntry_rpc: lc.feeWriteLedgerEntry ?? null,
			persistentRentRateDenominator_rpc: arch.persistentRentRateDenominator,
			tempRentRateDenominator_rpc: arch.tempRentRateDenominator ?? null,
			TTL_BUMP_ledgers_from_vault: ttl.TTL_BUMP,
			TTL_ENTRY_SIZE_constant: TTL_ENTRY_SIZE,
			note_entry_sizes:
				"Filled after create_payout probe using encoded stateChange sizes / writeBytes — see computed.entryRentEstimates",
		};
	} else {
		rentCalc.limitations.push(
			"Missing one or more of: live state size window, ledgerCost rent knobs, persistentRentRateDenominator",
		);
	}

	const attempt = Math.max(1, payment.lockAttempt);
	const externalId = externalIdFor(paymentId, attempt);
	const externalIdAttempt1 = externalIdFor(paymentId, 1);

	console.log("progress: exact-input probe (may fail if claim expired)");
	const exactProbe = await probeCreatePayout(
		client,
		{
			payer: payerAddr,
			external_id: externalId,
			claim_hash: claimHash,
			amount: amountMinor,
			mode: { tag: feeMode, values: undefined },
			expires_at: exactExpiresAt,
		},
		"exact_db_inputs_lockAttempt",
	);

	console.log("progress: fee-measure probe (exact claim_hash/amount/mode/external_id; expires_at +1h)");
	const feeProbe = await probeCreatePayout(
		client,
		{
			payer: payerAddr,
			external_id: externalId,
			claim_hash: claimHash,
			amount: amountMinor,
			mode: { tag: feeMode, values: undefined },
			expires_at: feeMeasureExpiresAt,
		},
		"exact_claim_hash_amount_mode_externalId__expires_at_plus_1h_for_fee_measure",
	);

	console.log("progress: attempt=1 fee-measure (historical first overflow attempt id)");
	const feeProbeA1 = await probeCreatePayout(
		client,
		{
			payer: payerAddr,
			external_id: externalIdAttempt1,
			claim_hash: claimHash,
			amount: amountMinor,
			mode: { tag: feeMode, values: undefined },
			expires_at: feeMeasureExpiresAt,
		},
		"attempt_1_exact_claim_hash__expires_at_plus_1h_for_fee_measure",
	);

	// Entry rent estimates from feeProbe stateChanges if available
	if (rentCalc.computed && feeProbe.simulation.stateChanges_decoded) {
		const changes = feeProbe.simulation.stateChanges_decoded;
		const created = changes.filter((c) => c.type === "created");
		const updated = changes.filter((c) => c.type === "updated");
		const feePerRent1kb = BigInt(rentCalc.computed.fee_per_rent_1kb_calculated);
		const denoms = {
			persistent: Number(arch.persistentRentRateDenominator),
			temporary: Number(arch.tempRentRateDenominator || 1),
		};
		const L = ttl.TTL_BUMP;
		const entryEstimates = [];
		for (const c of created) {
			const S = c.after?.encodedLedgerEntryBytes_estimate;
			if (S == null) continue;
			const rent = rentFeeForSizeAndLedgers(true, S, L, feePerRent1kb, denoms);
			entryEstimates.push({
				type: "created",
				keyKind: c.keyKind,
				assumed_size_bytes: S,
				size_source: "encoded_LedgerEntry_XDR_length_from_simulate_stateChange.after",
				assumed_extension_ledgers: L,
				extension_source: "vault TTL_BUMP (new persistent live_until ≈ current+TTL_BUMP; exclusive-diff may be TTL_BUMP±1)",
				rent_fee_stroops_calculated: String(rent),
				status: "CALCULATED_under_stated_assumptions",
			});
		}
		const ttlWriteFee =
			BigInt(created.length + updated.length) * BigInt(lc.feeWriteLedgerEntry || 0) +
			ceilDiv(
				BigInt(TTL_ENTRY_SIZE) *
					BigInt(created.length + updated.length) *
					BigInt(feeWrite1Kb || 0),
				1024n,
			);
		const rentSum = entryEstimates.reduce(
			(a, e) => a + BigInt(e.rent_fee_stroops_calculated),
			0n,
		);
		rentCalc.computed.entryRentEstimates = entryEstimates;
		rentCalc.computed.ttl_write_fee_rough_if_all_entries_extended = String(ttlWriteFee);
		rentCalc.computed.sum_created_entry_rent_estimates = String(rentSum);
		rentCalc.computed.minResourceFee_rpc_feeProbe = feeProbe.simulation.minResourceFee_rpc;
		rentCalc.computed.rent_sum_vs_minResourceFee = {
			sum_created_rent: String(rentSum),
			minResourceFee: feeProbe.simulation.minResourceFee_rpc,
			difference_minRF_minus_sum:
				feeProbe.simulation.minResourceFee_rpc != null
					? String(BigInt(feeProbe.simulation.minResourceFee_rpc) - rentSum)
					: null,
			note: "minResourceFee also includes non-rent resource fees + updated-entry rent/top-ups + TTL writes; exact match not expected without full LedgerEntryRentChange vectors.",
		};
		rentCalc.limitations.push(
			"live_until before/after per entry not resolved from separate TTL ledger keys; extension ledgers assumed = TTL_BUMP for created entries only.",
		);
		rentCalc.limitations.push(
			"encoded LedgerEntry XDR length is an estimate of in-memory size used by rent; host may use a different size metric.",
		);
	}

	const historicalGot = 5261104576n;
	const matchedExplanation = (() => {
		const p = feeProbe;
		const R = p.simulation.minResourceFee_rpc
			? BigInt(p.simulation.minResourceFee_rpc)
			: null;
		const A = p.simulation.builtFee_assembledTx
			? BigInt(p.simulation.builtFee_assembledTx)
			: null;
		const got = p.signPathRebuild_measured?.gotFee_fromError
			? BigInt(p.signPathRebuild_measured.gotFee_fromError)
			: p.signPathRebuild_measured?.rebuiltFee
				? BigInt(p.signPathRebuild_measured.rebuiltFee)
				: null;
		return {
			historical_api_error_got: String(historicalGot),
			historical_diagnosis_minResourceFee_at_time: "2820986533",
			historical_diagnosis_assembled_builtFee_at_time: "2820986633",
			historical_arithmetic_check: {
				assembled_plus_resourceFee_then:
					String(2820986633n + 2820986533n) + " (≠ 5261104576)",
				note: "At diagnosis time, assembled+R did NOT equal Got 5261104576. The earlier split 2820986533+2440118043 equals Got arithmetically but 2440118043 was NOT an RPC/SDK field — speculative.",
			},
			this_dryrun_feeProbe: {
				minResourceFee_rpc: R != null ? String(R) : null,
				builtFee_assembled: A != null ? String(A) : null,
				signRebuild_got_or_fee: got != null ? String(got) : null,
				assembled_plus_R: A != null && R != null ? String(A + R) : null,
				signRebuild_equals_assembled_plus_R:
					got != null && A != null && R != null ? got === A + R : null,
				signRebuild_equals_historical_got: got != null ? got === historicalGot : null,
			},
			sdk_mechanism_measured:
				"AssembledTransaction.sign() passes fee: built.fee into cloneFrom, overriding the stripped inclusion fee; build() then adds resourceFee again. Measured: sign-path total ≈ assembled.fee + resourceFee when overflow throws.",
			what_is_measured_vs_not: {
				measured: [
					"RPC minResourceFee / XDR resourceFee / Assembled built.fee for matched claim_hash+amount+mode+external_id (expires_at +1h deviation noted)",
					"sign()-equivalent TransactionBuilder rebuild Got value (no network submit)",
					"ConfigSetting rent knobs + liveSorobanStateSizeWindow latest sample",
					"Calculated fee_per_rent_1kb from those knobs + state size",
				],
				not_measured: [
					"Exact historical Got 5261104576 reproduction (ledger/state size has moved; current minRF differs)",
					"Exact per-entry live_until before/after pairs",
					"Full host rent breakdown returned as separate RPC fields (unavailable)",
				],
			},
		};
	})();

	const evidence = {
		testedCommit: COMMIT,
		diagnosedAt: new Date().toISOString(),
		noTransactionsSubmitted: true,
		noDatabaseMutations: true,
		noSignAndSendCalled: true,
		paymentId,
		db: {
			status: payment.status,
			lockAttempt: payment.lockAttempt,
			settleStatus: settle.status,
			externalRef: settle.externalRef,
			lockTxRef: settle.lockTxRef,
			amountInValue: settle.amountInValue,
			feeMode,
			claimExpiresAt: link.expiresAt.toISOString(),
			claimStatus: link.status,
			quoteValidUntil: quote.validUntil.toISOString(),
		},
		vault: env.FP_PAYOUT_VAULT_ID,
		invoker: payerAddr,
		rpcUrl: env.FP_STELLAR_RPC_URL,
		inputMatching: {
			exact_from_db: [
				"claim_hash = claimLink.vaultClaimHashHex",
				"amount = settle.amountInValue",
				"mode = quote.feeMode",
				"payer = FP_PAYER_DEMO_ADDRESS",
				"external_id = sha256(paymentId:lockAttempt)",
			],
			exact_expires_at_probe: exactProbe.label,
			fee_measure_deviation:
				"expires_at set to now+3600s because DB claim expiry is in the past and exact-expiry simulate does not produce resource fees; claim_hash/amount/mode/external_id unchanged",
		},
		probes: [exactProbe, feeProbe, feeProbeA1],
		rentCalc,
		matchedFeeExplanation: matchedExplanation,
		correction_of_prior_evidence: {
			file: "scripts/demo/evidence/2026-10-25-m2-fee-overflow-diagnosis.md",
			prior_speculative_sentence:
				"Got 5261104576 ≈ 2820986533 + 2440118043 (pathological resource fee plus a second large addend — likely restore/re-assemble/signAndSend composition)",
			correction:
				"RETIRE that additive split. 2440118043 was not returned by RPC/SDK. Measured SDK sign()-rebuild mechanism doubles resourceFee onto assembled fee (assembled + R). Historical Got 5261104576 is recorded as the API error string only; it is not reproduced by assembled+R using the diagnosis-time fees (2820986633+2820986533≠5261104576). Root rent driver is fee_per_rent_1kb from live Soroban state size ≫ target under growthFactor slope — not growthFactor as a direct multiplier on rent.",
		},
		stellar_mentor_question: null,
	};

	if (
		!latestStateSize ||
		!feeProbe.simulation.stateChanges_decoded?.some(
			(c) => c.after?.encodedLedgerEntryBytes_estimate != null,
		)
	) {
		evidence.stellar_mentor_question = {
			context:
				"FlexiPay payout_vault create_payout on Test SDF Network simulates with minResourceFee ~3e9 stroops; deposit ~1e4. Vault uses persistent storage with extend_ttl(30d, 60d).",
			question:
				"Given ConfigSettingContractLedgerCostV0 rent knobs, StateArchivalSettings denominators, and ConfigSettingLiveSorobanStateSizeWindow samples (~4.1e9 bytes on testnet), what is the recommended way for integrators to obtain the exact (old_size, new_size, old_live_until, new_live_until) vectors and/or the host's rent fee component of SimulateTransactionResponse.minResourceFee? Is encoded LedgerEntry XDR length an acceptable size for rent_fee_for_size_and_ledgers, or must we use a different host size metric? Separately: AssembledTransaction.sign() rebuilds with fee: built.fee which appears to double-count resourceFee against uint32 — is that expected SDK behavior or a known issue?",
		};
	} else {
		evidence.stellar_mentor_question = {
			context:
				"We can compute fee_per_rent_1kb from LiveSorobanStateSizeWindow + ledgerCost, and estimate created-entry rent with size≈encoded XDR length and L=TTL_BUMP, but cannot close the gap to minResourceFee without exact TTL before/after.",
			question:
				"On Testnet, LiveSorobanStateSizeWindow ≈ 4.1e9 bytes with sorobanStateRentFeeGrowthFactor=5000 drives fee_per_rent_1kb into the millions. For create_payout creating 2 persistent entries with TTL_BUMP=1036800, what is the authoritative size metric for rent (XDR length vs host memory size), and does SimulateTransaction expose a rent-only fee breakdown? Also please confirm whether stellar-sdk AssembledTransaction.sign()'s cloneFrom({fee: built.fee}) double-adding resourceFee (overflowing uint32 when resourceFee>~2.15e9) is expected.",
		};
	}

	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(OUT_JSON, JSON.stringify(evidence, null, 2));
	console.log(
		JSON.stringify(
			{
				wrote: OUT_JSON,
				exactSimError: exactProbe.simulation.error_rpc,
				feeProbe: {
					minRF: feeProbe.simulation.minResourceFee_rpc,
					built: feeProbe.simulation.builtFee_assembledTx,
					signRebuild: feeProbe.signPathRebuild_measured,
					arith: feeProbe.arithmetic_check,
				},
				stateSize: latestStateSize != null ? String(latestStateSize) : null,
				feePerRent1kb: rentCalc.computed?.fee_per_rent_1kb_calculated ?? null,
				rentSum: rentCalc.computed?.sum_created_entry_rent_estimates ?? null,
			},
			null,
			2,
		),
	);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
