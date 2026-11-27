/** Claim page wallet tips: devnet wording in test mode; KAST tip only with real money. */
import assert from "node:assert/strict"
import { createElement, type ComponentType } from "react"
import { renderToString } from "react-dom/server"
import { describe, test } from "vitest"

const load = <T>(path: string): Promise<T> =>
	import(/* @vite-ignore */ path) as Promise<T>

const { NoWalletYetHelp } = await load<{
	NoWalletYetHelp: ComponentType<{ live?: boolean }>
}>("../src/components/claim/NoWalletYetHelp.tsx")

const render = (live?: boolean) =>
	renderToString(createElement(NoWalletYetHelp, { live }))

describe("NoWalletYetHelp", () => {
	test("test mode: devnet instructions, no KAST tip", () => {
		const html = render()
		assert.match(html, /switch the wallet to Devnet/)
		assert.doesNotMatch(html, /claim-kast-help/)
	})

	test("live: no devnet wording, KAST tip points at the Solana address", () => {
		const html = render(true)
		assert.doesNotMatch(html, /Devnet/)
		assert.match(html, /claim-kast-help/)
		assert.match(html, /Got a KAST account\?/)
		assert.match(html, /USDC deposit address on the Solana network/)
		assert.match(html, /href="https:\/\/www\.kast\.xyz"/)
	})
})
