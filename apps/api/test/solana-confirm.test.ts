import assert from "node:assert/strict";
import { afterEach, describe, test } from "vitest";
import { Keypair } from "@solana/web3.js";
import { evaluateParsedTransfer } from "@flexipay/adapter-solana";
import type { ParsedTransactionWithMeta } from "@solana/web3.js";
import { auth, startTestServer } from "./helpers.ts";
import { resetSolanaRuntimeConfigCache } from "../src/solana/runtime-config.ts";
import { setSolanaVerifyForTests } from "../src/solana/verify.ts";

const recipient = Keypair.generate().publicKey.toBase58();
const mint = Keypair.generate().publicKey.toBase58();
const flexipayMinor = "10000000"; // 1 USDC @ 7 decimals

afterEach(() => {
	setSolanaVerifyForTests(null);
	resetSolanaRuntimeConfigCache();
});

describe("CCR-24 Solana claim + confirm", () => {
	test("accept leaves processing; confirm pays only after verify", async () => {
		process.env.FP_SETTLEMENT = "mock";
		process.env.FP_SOLANA_CLUSTER = "devnet";
		process.env.FP_SOLANA_USDC_MINT = mint;
		process.env.FP_SOLANA_USDC_DECIMALS = "7";
		resetSolanaRuntimeConfigCache();

		const fixtureTx = {
			slot: 99,
			transaction: { message: { accountKeys: [], instructions: [] } },
			meta: {
				err: null,
				preTokenBalances: [
					{
						accountIndex: 0,
						mint,
						owner: recipient,
						uiTokenAmount: { amount: "0", decimals: 7 },
					},
				],
				postTokenBalances: [
					{
						accountIndex: 0,
						mint,
						owner: recipient,
						uiTokenAmount: { amount: flexipayMinor, decimals: 7 },
					},
				],
			},
		} as unknown as ParsedTransactionWithMeta;

		const pendingSig = "pending-sig-" + "p".repeat(48);
		const badSig = "bad-sig-" + "b".repeat(52);
		const okSig = "ok-sig-" + "1".repeat(52);
		const otherSig = "other-sig-" + "2".repeat(48);

		setSolanaVerifyForTests(async (_rpc, input) => {
			if (input.signature === pendingSig) {
				return { ok: false, reason: "not_found", message: "not yet" };
			}
			if (input.signature === badSig) {
				return { ok: false, reason: "amount_too_low", message: "too low" };
			}
			// Successful path: require mint/recipient match, then accept requested amount.
			const parsed = evaluateParsedTransfer(fixtureTx, {
				signature: input.signature,
				mint: input.mint,
				recipientOwner: input.recipientOwner,
				amountMinor: 1n,
				usdcDecimals: input.usdcDecimals,
			});
			if (!parsed.ok) return parsed;
			return {
				ok: true,
				signature: input.signature,
				amountMinor: input.amountMinor,
				mint: input.mint,
				recipientOwner: input.recipientOwner,
				slot: 99,
			};
		});

		const api = await startTestServer();
		const { key } = await api.newOrg("Solana Confirm Org");
		try {
			const created = await fetch(`${api.base}/v1/recipients`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "s-rcp" }),
				body: JSON.stringify({
					name: "Recv",
					kind: "individual",
					country: "PH",
				}),
			});
			assert.equal(created.status, 201);
			const rcp = (await created.json()) as { id: string };

			const quoteRes = await fetch(`${api.base}/v1/quotes`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "s-quote" }),
				body: JSON.stringify({
					source: { type: "bank_account", currency: "USD", country: "US" },
					destination: {
						type: "crypto_wallet",
						currency: "USDC",
						country: "PH",
						recipientKind: "individual",
					},
					amount: {
						side: "receive",
						value: { amount: flexipayMinor, currency: "USDC" },
					},
					policy: "cheapest",
					feeMode: "PayerPays",
				}),
			});
			const quoteText = await quoteRes.text();
			assert.equal(quoteRes.status, 201, quoteText);
			const quote = JSON.parse(quoteText) as { id: string };

			const paymentRes = await fetch(`${api.base}/v1/payments`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "s-pay" }),
				body: JSON.stringify({
					quoteId: quote.id,
					recipientId: rcp.id,
					delivery: "claim_link",
					profile: "one_off",
				}),
			});
			const paymentText = await paymentRes.text();
			assert.equal(paymentRes.status, 201, paymentText);
			const payment = JSON.parse(paymentText) as {
				id: string;
				claimLink: { url: string };
			};

			const fundRes = await fetch(`${api.base}/v1/payments/${payment.id}/fund`, {
				method: "POST",
				headers: auth(key, { "idempotency-key": "s-fund" }),
				body: "{}",
			});
			const fundText = await fundRes.text();
			assert.equal(fundRes.status, 200, fundText);

			const token = payment.claimLink.url.split("/").pop()!;
			const accept = await fetch(`${api.base}/v1/claims/${token}/accept`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"idempotency-key": "s-accept",
				},
				body: JSON.stringify({
					endpoint: {
						type: "crypto_wallet",
						country: "",
						currency: "USDC",
						network: "solana",
						details: { address: recipient },
						simulated: true,
					},
				}),
			});
			const acceptText = await accept.text();
			assert.equal(accept.status, 200, acceptText);
			const accepted = JSON.parse(acceptText) as {
				paymentStatus: string;
				claim: { status: string };
			};
			assert.equal(accepted.claim.status, "accepted");
			assert.equal(accepted.paymentStatus, "processing");

			const pending = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-pending" }),
					body: JSON.stringify({ signature: pendingSig }),
				},
			);
			assert.equal(pending.status, 202);

			const rejected = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-bad" }),
					body: JSON.stringify({ signature: badSig }),
				},
			);
			assert.equal(rejected.status, 422);

			const confirm = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-ok" }),
					body: JSON.stringify({ signature: okSig }),
				},
			);
			const confirmText = await confirm.text();
			assert.equal(confirm.status, 200, confirmText);
			const body = JSON.parse(confirmText) as {
				paymentStatus: string;
				signature: string;
			};
			assert.equal(body.paymentStatus, "paid");
			assert.equal(body.signature, okSig);

			const replay = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-replay" }),
					body: JSON.stringify({ signature: okSig }),
				},
			);
			assert.equal(replay.status, 200);

			const conflict = await fetch(
				`${api.base}/v1/payments/${payment.id}/solana/confirm`,
				{
					method: "POST",
					headers: auth(key, { "idempotency-key": "s-conf-conflict" }),
					body: JSON.stringify({ signature: otherSig }),
				},
			);
			assert.equal(conflict.status, 409);
		} finally {
			await api.stop();
		}
	}, 120_000);
});
