import assert from "node:assert/strict"
import { type Event } from "@flexipay/web-lib/contract"
import { describe, test } from "vitest"
import { type EndpointSummary } from "../src/api/client.ts"
import {
	formatDestinationLabel,
	maskAccount,
	onchainDestinationFromEvents,
	payerFromEvents,
} from "../src/payments/paymentParties.ts"

const event = (type: string, snapshot: Record<string, unknown> = {}): Event =>
	({
		id: "evt_1",
		type,
		createdAt: "2026-11-05T12:00:00.000Z",
		paymentId: "pay_1",
		snapshot,
	}) as Event

describe("paymentParties", () => {
	test("reads payer and destination from payment.onchain", () => {
		const events = [
			event("payment.created"),
			event("payment.onchain", {
				payer: "PayEr111111111111111111111111111111111111",
				destination: "Dest222222222222222222222222222222222222",
			}),
		]
		assert.equal(
			payerFromEvents(events),
			"PayEr111111111111111111111111111111111111",
		)
		assert.equal(
			onchainDestinationFromEvents(events),
			"Dest222222222222222222222222222222222222",
		)
		assert.equal(payerFromEvents([event("payment.paid")]), null)
	})

	test("masks bank accounts and shortens wallets", () => {
		assert.equal(maskAccount("12345678"), "••••5678")
		const bank = {
			type: "bank_account",
			details: { accountNumber: "99887766" },
		} as unknown as EndpointSummary
		assert.equal(formatDestinationLabel(bank), "Bank ••••7766")
		const wallet = {
			type: "crypto_wallet",
			details: { address: "AbCdEfGhIjKlMnOpQrStUvWxYz1234567890abcd" },
		} as unknown as EndpointSummary
		assert.match(formatDestinationLabel(wallet), /^AbCd…abcd$/)
	})
})
