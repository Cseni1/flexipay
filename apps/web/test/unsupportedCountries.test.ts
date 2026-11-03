import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	ADD_FUNDS_COUNTRY_OPTIONS,
	isUnsupportedBuyCountry,
	UNSUPPORTED_BUY_COUNTRY_CODES,
} from "../src/transak/unsupportedCountries.ts"

describe("unsupported buy countries", () => {
	test("includes GB and ZA among the blocked ISO codes", () => {
		assert.ok(UNSUPPORTED_BUY_COUNTRY_CODES.includes("GB"))
		assert.ok(UNSUPPORTED_BUY_COUNTRY_CODES.includes("ZA"))
		assert.equal(isUnsupportedBuyCountry("GB"), true)
		assert.equal(isUnsupportedBuyCountry("gb"), true)
		assert.equal(isUnsupportedBuyCountry("ZA"), true)
		assert.equal(isUnsupportedBuyCountry("US"), false)
		assert.equal(isUnsupportedBuyCountry("PH"), false)
		assert.equal(isUnsupportedBuyCountry(""), false)
	})

	test("lists every blocked code exactly once", () => {
		assert.equal(
			new Set(UNSUPPORTED_BUY_COUNTRY_CODES).size,
			UNSUPPORTED_BUY_COUNTRY_CODES.length,
		)
		for (const code of UNSUPPORTED_BUY_COUNTRY_CODES) {
			assert.match(code, /^[A-Z]{2}$/)
			assert.equal(isUnsupportedBuyCountry(code), true)
		}
	})

	test("country selector options include GB and ZA", () => {
		const values = ADD_FUNDS_COUNTRY_OPTIONS.map((option) => option.value)
		assert.ok(values.includes("GB"))
		assert.ok(values.includes("ZA"))
		assert.ok(values.includes("US"))
	})
})
