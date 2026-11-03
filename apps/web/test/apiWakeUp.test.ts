import assert from "node:assert/strict"
import { describe, test } from "vitest"
import {
	ApiError,
	API_WAKE_UP_MESSAGE,
	describeApiError,
	isTransientApiError,
} from "../src/api/client.ts"

describe("API wake-up helpers", () => {
	test("treats network, waking and 5xx as transient", () => {
		assert.equal(
			isTransientApiError(new ApiError(0, "network_error", "offline")),
			true,
		)
		assert.equal(
			isTransientApiError(new ApiError(0, "api_waking", API_WAKE_UP_MESSAGE)),
			true,
		)
		assert.equal(
			isTransientApiError(new ApiError(503, "http_503", "sleeping")),
			true,
		)
		assert.equal(
			isTransientApiError(new ApiError(500, "internal_error", '{"x":1}')),
			true,
		)
		assert.equal(
			isTransientApiError(new ApiError(400, "bad_request", "nope")),
			false,
		)
		assert.equal(
			isTransientApiError(
				new ApiError(503, "frontend_auth_not_configured", "key missing"),
			),
			false,
		)
	})

	test("wake-up copy never includes JSON", () => {
		assert.equal(API_WAKE_UP_MESSAGE.includes("{"), false)
		assert.match(API_WAKE_UP_MESSAGE, /Waking up the server/i)
		assert.match(API_WAKE_UP_MESSAGE, /minute/i)
	})

	test("describeApiError hides raw 5xx payloads", () => {
		const raw = new ApiError(503, "internal_error", '{"stack":"boom"}')
		assert.equal(describeApiError(raw), API_WAKE_UP_MESSAGE)
		assert.equal(describeApiError(raw).includes("{"), false)
	})
})
