import assert from "node:assert/strict"
import { afterEach, describe, test } from "vitest"
import { AuthRequestError, changePassword } from "../src/api/auth.ts"

describe("changePassword", () => {
	let originalFetch: typeof fetch | undefined

	afterEach(() => {
		if (originalFetch) {
			globalThis.fetch = originalFetch
			originalFetch = undefined
		}
	})

	test("posts current and new password to Better Auth", async () => {
		originalFetch = globalThis.fetch
		const seen: { url: string; body: unknown } = { url: "", body: null }
		globalThis.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url
			seen.url = url
			seen.body = init?.body ? JSON.parse(String(init.body)) : null
			return new Response(JSON.stringify({ token: null, user: { id: "u1" } }), {
				status: 200,
				headers: { "content-type": "application/json" },
			})
		}
		await changePassword({
			currentPassword: "old-password-1",
			newPassword: "new-password-1",
		})
		assert.equal(seen.url, "/api/auth/change-password")
		assert.deepEqual(seen.body, {
			currentPassword: "old-password-1",
			newPassword: "new-password-1",
		})
	})

	test("maps Better Auth failures to AuthRequestError messages", async () => {
		originalFetch = globalThis.fetch
		globalThis.fetch = async () =>
			new Response(
				JSON.stringify({
					code: "INVALID_PASSWORD",
					message: "Invalid password",
				}),
				{ status: 400, headers: { "content-type": "application/json" } },
			)
		await assert.rejects(
			() =>
				changePassword({
					currentPassword: "wrong",
					newPassword: "new-password-1",
				}),
			(error: unknown) => {
				assert.ok(error instanceof AuthRequestError)
				assert.equal(error.status, 400)
				assert.equal(error.message, "Invalid password")
				return true
			},
		)
	})
})
