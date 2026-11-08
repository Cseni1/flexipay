import assert from "node:assert/strict"
import { afterEach, describe, test, vi } from "vitest"
import {
	confirmBlindpayPayout,
	requestBlindpayDelegation,
	saveBlindpayTos,
	startBlindpayOnboarding,
	submitBlindpayKyc,
	uploadBlindpayKycFile,
} from "../src/api/client.ts"

// CCR-45: the browser client for BlindPay sender onboarding and sender-wallet payouts.

type Call = { url: string; init: RequestInit | undefined }
let calls: Call[] = []
const stubFetch = (status: number, body: unknown) =>
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, init })
			return new Response(JSON.stringify(body), { status })
		}),
	)

afterEach(() => {
	calls = []
	vi.unstubAllGlobals()
})

const wallet = "ATgdUGhxWZZbh7FC6SJgT4M1GLExHZGzirn3jMaA8ZLG"
const onboarding = {
	receiverId: null,
	kycStatus: null,
	next: { step: "accept_terms", url: "https://app.blindpay.com/tos/abc" },
}
const kyc = {
	email: "maria@example.com",
	first_name: "Maria",
	last_name: "Santos",
	date_of_birth: "1990-01-01",
	tax_id: "123456",
	address_line_1: "1 High Street",
	city: "London",
	state_province_region: "London",
	postal_code: "SW1A 1AA",
	country: "GB",
	id_doc_country: "GB",
	id_doc_type: "PASSPORT",
	id_doc_front_file: "https://files.example.com/id.png",
	selfie_file: "https://files.example.com/selfie.png",
}

const sent = (i = 0) => ({
	url: calls[i]!.url,
	method: calls[i]!.init?.method,
	body: JSON.parse(String(calls[i]!.init?.body ?? "{}")),
	idem: new Headers(calls[i]!.init?.headers).get("idempotency-key"),
})

describe("BlindPay sender onboarding client", () => {
	test("start, terms and KYC post with an idempotency key and parse the next step", async () => {
		stubFetch(200, onboarding)
		const started = await startBlindpayOnboarding()
		assert.equal(started.next.step, "accept_terms")
		assert.equal(sent().url, "/v1/blindpay/onboarding")
		assert.equal(sent().method, "POST")
		assert.ok(sent().idem)

		stubFetch(200, { ...onboarding, next: { step: "submit_kyc" } })
		assert.equal((await saveBlindpayTos("tos_1")).next.step, "submit_kyc")
		assert.deepEqual(sent(1).body, { tosId: "tos_1" })

		stubFetch(200, {
			receiverId: "re_1",
			kycStatus: "verifying",
			next: { step: "wait_for_review", kycStatus: "verifying" },
		})
		const after = await submitBlindpayKyc(kyc)
		assert.equal(after.next.step, "wait_for_review")
		assert.equal(sent(2).url, "/v1/blindpay/onboarding/kyc")
	})

	test("KYC is validated before anything is sent", async () => {
		stubFetch(200, onboarding)
		assert.throws(() => submitBlindpayKyc({ ...kyc, email: "not-an-email" }))
		assert.equal(calls.length, 0)
	})
})

describe("BlindPay sender-wallet payout client", () => {
	test("delegation asks for the transaction to sign for the sender's wallet", async () => {
		stubFetch(200, {
			transaction: "AQAAA",
			quoteId: "qu_1",
			expiresAt: "2026-11-08T13:05:00.000Z",
			ownerAddress: wallet,
		})
		const d = await requestBlindpayDelegation("pay 1", wallet)
		assert.equal(d.quoteId, "qu_1")
		assert.equal(sent().url, "/v1/payments/pay%201/blindpay/delegation")
		assert.deepEqual(sent().body, { ownerAddress: wallet })
	})

	test("confirm returns accepted, and surfaces API errors", async () => {
		stubFetch(200, {
			status: "accepted",
			payoutId: "po_1",
			paymentStatus: "processing",
		})
		const ok = await confirmBlindpayPayout("pay_1", "5".repeat(88))
		assert.equal(ok.status, "accepted")
		assert.deepEqual(sent().body, { signature: "5".repeat(88) })

		stubFetch(422, {
			code: "kyc_required",
			message: "Finish identity checks first",
		})
		await assert.rejects(
			confirmBlindpayPayout("pay_1", "5".repeat(88)),
			(e: { code?: string }) => e.code === "kyc_required",
		)
	})
})

describe("CCR-46 KYC file upload client", () => {
	test("sends the file as the raw body with its own content type", async () => {
		stubFetch(200, { fileUrl: "https://files.blindpay.com/1-kyc.png" })
		const file = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" })
		const out = await uploadBlindpayKycFile(file)
		assert.equal(out.fileUrl, "https://files.blindpay.com/1-kyc.png")
		assert.equal(calls[0]!.url, "/v1/blindpay/onboarding/upload")
		assert.equal(calls[0]!.init?.method, "POST")
		assert.equal(
			new Headers(calls[0]!.init?.headers).get("content-type"),
			"image/png",
		)
		assert.equal(calls[0]!.init?.body, file)
	})

	test("rejects a response without an https file URL, and API errors", async () => {
		stubFetch(200, { fileUrl: "http://insecure.example/x" })
		await assert.rejects(uploadBlindpayKycFile(new Blob([new Uint8Array([1])])))
		stubFetch(415, { code: "unsupported_file_type", message: "Upload a JPEG" })
		await assert.rejects(
			uploadBlindpayKycFile(
				new Blob([new Uint8Array([1])], { type: "image/gif" }),
			),
			(e: { code?: string }) => e.code === "unsupported_file_type",
		)
	})
})
