import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	buildCreateOnrampOrderBody,
	parseOnrampAmountUsd,
	readCrossmintClientKey,
} from "../src/onramp/orders.ts"

describe("onramp order request builder", () => {
	test("builds walletAddress and amountUsd string for whole dollars 5–100", () => {
		assert.deepEqual(
			buildCreateOnrampOrderBody({
				walletAddress: "  So11111111111111111111111111111111111111112  ",
				amountUsd: "25",
			}),
			{
				walletAddress: "So11111111111111111111111111111111111111112",
				amountUsd: "25",
			},
		)
		assert.deepEqual(
			buildCreateOnrampOrderBody({
				walletAddress: "So11111111111111111111111111111111111111112",
				amountUsd: 100,
			}),
			{
				walletAddress: "So11111111111111111111111111111111111111112",
				amountUsd: "100",
			},
		)
	})

	test("rejects amounts outside 5–100 or non-whole values", () => {
		assert.equal(parseOnrampAmountUsd("4").ok, false)
		assert.equal(parseOnrampAmountUsd("101").ok, false)
		assert.equal(parseOnrampAmountUsd("25.5").ok, false)
		assert.equal(parseOnrampAmountUsd("").ok, false)
		assert.throws(() =>
			buildCreateOnrampOrderBody({
				walletAddress: "So111",
				amountUsd: "4",
			}),
		)
		assert.throws(() =>
			buildCreateOnrampOrderBody({
				walletAddress: "  ",
				amountUsd: "25",
			}),
		)
	})

	test("readCrossmintClientKey trims or returns undefined", () => {
		assert.equal(
			readCrossmintClientKey({ VITE_CROSSMINT_CLIENT_KEY: "  ck_x  " }),
			"ck_x",
		)
		assert.equal(
			readCrossmintClientKey({ VITE_CROSSMINT_CLIENT_KEY: "" }),
			undefined,
		)
		assert.equal(readCrossmintClientKey({}), undefined)
	})
})
