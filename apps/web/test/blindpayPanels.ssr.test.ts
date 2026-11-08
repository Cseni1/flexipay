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

const { default: BlindpayTermsDone } = await load<{ default: ComponentType }>(
	"../src/pages/BlindpayTermsDone.tsx",
)
const { MemoryRouter } = await import("react-router-dom")

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
		const hrefs = [...terms.matchAll(/href="([^"]*)"/g)].map((m) => m[1])
		assert.deepEqual(hrefs, ["https://app.blindpay.com/tos/x"])
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

describe("CCR-46 identity form and terms return page", () => {
	test("the identity form asks for photo uploads, not links", () => {
		const html = kyc({ step: "submit_kyc" })
		assert.ok(html.includes('type="file"'))
		assert.ok(html.includes("Photo of your ID (front)"))
		assert.ok(!html.includes("Selfie URL"))
		assert.ok(!html.includes("ID document URL"))
	})

	test("a rejected identity can be submitted again", () => {
		const html = kyc({ step: "wait_for_review", kycStatus: "rejected" })
		assert.ok(html.includes("could not verify your identity"))
		assert.ok(html.includes("Submit again"))
	})

	const page = (path: string) =>
		renderToString(
			createElement(
				MemoryRouter,
				{ initialEntries: [path] },
				createElement(BlindpayTermsDone),
			),
		)

	test("terms return page: saving state with an id, warning without one", () => {
		assert.ok(
			page("/blindpay/terms-done?tos_id=tos_1").includes(
				"Saving your acceptance",
			),
		)
		assert.ok(
			page("/blindpay/terms-done").includes(
				"did not return a terms acceptance",
			),
		)
	})
})
