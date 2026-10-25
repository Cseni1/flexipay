import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;

beforeAll(async () => {
	t = await startTestServer();
}, 180_000);

afterAll(async () => {
	await t.stop();
});

async function openClaimToken(key: string): Promise<{ token: string; paymentId: string }> {
	const recipient = (await (
		await fetch(`${t.base}/v1/recipients`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				name: "Worker A",
				kind: "individual",
				country: "PH",
			}),
		})
	).json()) as { id: string };
	const quote = (await (
		await fetch(`${t.base}/v1/quotes`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				source: { type: "bank_account", currency: "USD", country: "US" },
				destination: {
					type: "crypto_wallet",
					currency: "USDC",
					country: "PH",
					recipientKind: "individual",
				},
				amount: {
					side: "send",
					value: { amount: "100000", currency: "USD" },
				},
				policy: "cheapest",
				feeMode: "PayerPays",
			}),
		})
	).json()) as { id: string };
	const payment = (await (
		await fetch(`${t.base}/v1/payments`, {
			method: "POST",
			headers: auth(key),
			body: JSON.stringify({
				quoteId: quote.id,
				recipientId: recipient.id,
				delivery: "claim_link",
				profile: "one_off",
			}),
		})
	).json()) as { id: string; claimLink: { url: string } | null };
	return {
		paymentId: payment.id,
		token: payment.claimLink!.url.split("/").pop()!,
	};
}

/** Valid-looking C… for schema; not a real deployed wallet. */
const FAKE_CONTRACT = "C".padEnd(56, "A");

describe("CCR-20 passkey prepare/submit routes (no live testnet)", () => {
	it("prepare rejects when passkey wallet is not deployed on the claim", async () => {
		const { key } = await t.newOrg("Passkey Prepare Org");
		const { token } = await openClaimToken(key);
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/prepare`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contractId: FAKE_CONTRACT }),
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("invalid_state");
	});

	it("prepare rejects contractId mismatch after deploy binding", async () => {
		const { key } = await t.newOrg("Passkey Prepare Org 2");
		const { token, paymentId } = await openClaimToken(key);
		await t.db.claimLink.update({
			where: { paymentId },
			data: {
				passkeyContractId: FAKE_CONTRACT,
				passkeyDeployTxHash: "ab".repeat(32),
			},
		});
		const other = "C".padEnd(56, "B");
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/prepare`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contractId: other }),
		});
		expect(res.status).toBe(422);
		expect(((await res.json()) as { code: string }).code).toBe("contract_mismatch");
	});

	it("prepare returns 502 when claim secret seal is missing (after binding + settle wait)", async () => {
		const { key } = await t.newOrg("Passkey Prepare Org 3");
		const { token, paymentId } = await openClaimToken(key);
		await t.db.claimLink.update({
			where: { paymentId },
			data: {
				passkeyContractId: FAKE_CONTRACT,
				passkeyDeployTxHash: "cd".repeat(32),
			},
		});
		const payment = await t.db.payment.findUniqueOrThrow({
			where: { id: paymentId },
			include: { legs: true },
		});
		const settle = payment.legs.find((l) => l.kind === "settle");
		if (settle) {
			await t.db.payment.update({
				where: { id: paymentId },
				data: { status: "processing" },
			});
			await t.db.leg.update({
				where: { id: settle.id },
				data: { status: "processing", externalRef: "1" },
			});
		}
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/prepare`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ contractId: FAKE_CONTRACT }),
		});
		expect(res.status).toBe(502);
		const body = (await res.json()) as { code: string; message: string };
		expect(body.code).toBe("prepare_failed");
		expect(body.message).toMatch(/secret seal/i);
	});

	it("prepare returns 502 when FP_PAYER_DEMO_SECRET is missing (seal present)", async () => {
		const prev = process.env.FP_PAYER_DEMO_SECRET;
		delete process.env.FP_PAYER_DEMO_SECRET;
		try {
			const { key } = await t.newOrg("Passkey Prepare Org 4");
			const { token, paymentId } = await openClaimToken(key);
			const { sealClaimSecret } = await import("../src/orchestrator/claim-seal.ts");
			const { sealed, nonce } = sealClaimSecret("ab".repeat(32), t.runtime.claimSealKey);
			await t.db.claimLink.update({
				where: { paymentId },
				data: {
					passkeyContractId: FAKE_CONTRACT,
					passkeyDeployTxHash: "ef".repeat(32),
					vaultClaimHashHex: "11".repeat(32),
					secretSealed: sealed,
					secretSealedNonce: nonce,
				},
			});
			const payment = await t.db.payment.findUniqueOrThrow({
				where: { id: paymentId },
				include: { legs: true },
			});
			const settle = payment.legs.find((l) => l.kind === "settle");
			if (settle) {
				await t.db.payment.update({
					where: { id: paymentId },
					data: { status: "processing" },
				});
				await t.db.leg.update({
					where: { id: settle.id },
					data: { status: "processing", externalRef: "99" },
				});
			}
			const res = await fetch(`${t.base}/v1/claims/${token}/passkey/prepare`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ contractId: FAKE_CONTRACT }),
			});
			expect(res.status).toBe(502);
			const body = (await res.json()) as { code: string; message: string };
			expect(body.code).toBe("prepare_failed");
			expect(body.message).toMatch(/FP_PAYER_DEMO_SECRET/);
		} finally {
			if (prev === undefined) delete process.env.FP_PAYER_DEMO_SECRET;
			else process.env.FP_PAYER_DEMO_SECRET = prev;
		}
	});

	it("submit requires Idempotency-Key", async () => {
		const { key } = await t.newOrg("Passkey Submit Org");
		const { token } = await openClaimToken(key);
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/submit`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				prepareId: "pkp_missing",
				contractId: FAKE_CONTRACT,
				signedAuthEntries: ["AAAA"],
			}),
		});
		expect(res.status).toBe(400);
		expect(((await res.json()) as { code: string }).code).toBe(
			"missing_idempotency_key",
		);
	});

	it("submit returns 409 when passkey not deployed", async () => {
		const { key } = await t.newOrg("Passkey Submit Org 2");
		const { token } = await openClaimToken(key);
		const res = await fetch(`${t.base}/v1/claims/${token}/passkey/submit`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"idempotency-key": "submit-no-deploy",
			},
			body: JSON.stringify({
				prepareId: "pkp_x",
				contractId: FAKE_CONTRACT,
				signedAuthEntries: ["AAAA"],
			}),
		});
		expect(res.status).toBe(409);
		expect(((await res.json()) as { code: string }).code).toBe("invalid_state");
	});
});
