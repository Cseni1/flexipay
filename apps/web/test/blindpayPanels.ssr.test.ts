/**
 * CCR-45: first-frame render of the BlindPay sender panels (identity steps and wallet
 * approval). Effects do not run in a static render, so nothing is fetched.
 */
import assert from "node:assert/strict"
import { createElement, type ComponentType } from "react"
import { renderToString } from "react-dom/server"
import { describe, test } from "vitest"

const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>

const { SenderKycPanel } = await load<{
	SenderKycPanel: ComponentType<{ details: unknown }>
}>("../src/components/payments/SenderKycPanel.tsx")
const { BlindpaySenderPanel } = await load<{
	BlindpaySenderPanel: ComponentType<{
		paymentId: string
		onChanged: () => void
	}>
}>("../src/components/solana/BlindpaySenderPanel.tsx")

const kyc = (details: unknown) =>
	renderToString(createElement(SenderKycPanel, { details }))

describe("SenderKycPanel", () => {
	test("renders nothing without a known step", () => {
		assert.equal(kyc(null), "")
		assert.equal(kyc({ step: "unknown" }), "")
	})

	test("each BlindPay identity step renders", () => {
		const terms = kyc({
			step: "accept_terms",
			url: "https://app.blindpay.com/tos/x",
		})
		assert.match(terms, /https:\/\/app\.blindpay\.com\/tos\/x/)
		assert.ok(kyc({ step: "submit_kyc" }).length > 200)
		assert.ok(
			kyc({ step: "wait_for_review", kycStatus: "verifying" }).length > 0,
		)
		assert.ok(kyc({ step: "approved", receiverId: "re_1" }).length >= 0)
	})
})

describe("BlindpaySenderPanel", () => {
	test("first frame renders without fetching", () => {
		const html = renderToString(
			createElement(BlindpaySenderPanel, {
				paymentId: "pay_1",
				onChanged: () => {},
			}),
		)
		assert.ok(html.length > 0)
	})
})
