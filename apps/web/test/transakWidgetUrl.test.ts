import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	buildTransakStagingWidgetUrl,
	readTransakStagingKey,
	resolveAddFundsGate,
	TRANSAK_STAGING_WIDGET_ORIGIN,
} from "../src/transak/widgetUrl.ts"

describe("buildTransakStagingWidgetUrl", () => {
	test("targets Solana USDC STAGING with the wallet destination", () => {
		const wallet = "So11111111111111111111111111111111111111112"
		const href = buildTransakStagingWidgetUrl({
			apiKey: "staging-public-key",
			walletAddress: wallet,
		})
		const url = new URL(href)
		assert.equal(url.origin, TRANSAK_STAGING_WIDGET_ORIGIN)
		assert.equal(url.searchParams.get("apiKey"), "staging-public-key")
		assert.equal(url.searchParams.get("walletAddress"), wallet)
		assert.equal(url.searchParams.get("network"), "solana")
		assert.equal(url.searchParams.get("cryptoCurrencyCode"), "USDC")
		assert.equal(url.searchParams.get("environment"), "STAGING")
	})

	test("rejects a blank key or wallet", () => {
		assert.throws(() =>
			buildTransakStagingWidgetUrl({
				apiKey: "  ",
				walletAddress: "Abc",
			}),
		)
		assert.throws(() =>
			buildTransakStagingWidgetUrl({
				apiKey: "key",
				walletAddress: "",
			}),
		)
	})
})

describe("readTransakStagingKey", () => {
	test("returns trimmed key or undefined when missing", () => {
		assert.equal(
			readTransakStagingKey({ VITE_TRANSAK_STAGING_KEY: "  abc  " }),
			"abc",
		)
		assert.equal(
			readTransakStagingKey({ VITE_TRANSAK_STAGING_KEY: "" }),
			undefined,
		)
		assert.equal(readTransakStagingKey({}), undefined)
	})
})

describe("resolveAddFundsGate", () => {
	test("asks to connect when the key is set but no wallet is connected", () => {
		assert.deepEqual(resolveAddFundsGate("staging-key", null), {
			status: "connect_first",
		})
		assert.deepEqual(resolveAddFundsGate("staging-key", "  "), {
			status: "connect_first",
		})
	})

	test("is unconfigured without a key", () => {
		assert.deepEqual(resolveAddFundsGate(undefined, "So111"), {
			status: "unconfigured",
		})
	})

	test("is ready with a staging URL when both are present", () => {
		const wallet = "So11111111111111111111111111111111111111112"
		const gate = resolveAddFundsGate("staging-key", wallet)
		assert.equal(gate.status, "ready")
		if (gate.status !== "ready") return
		const url = new URL(gate.url)
		assert.equal(url.searchParams.get("walletAddress"), wallet)
		assert.equal(url.searchParams.get("network"), "solana")
		assert.equal(url.searchParams.get("cryptoCurrencyCode"), "USDC")
		assert.equal(url.searchParams.get("environment"), "STAGING")
	})
})
