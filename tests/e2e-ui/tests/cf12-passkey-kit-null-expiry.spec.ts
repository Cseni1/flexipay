import { expect, test } from "@playwright/test"
import { readFile } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { nativeToScVal, scValToNative } from "@stellar/stellar-sdk"

// CF12: the passkey-kit 0.19.1 null-expiry patch must be applied. Fixture only.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const kitPath = join(repoRoot, "node_modules/passkey-kit/dist/kit.js")
const patchPath = join(repoRoot, "patches/passkey-kit+0.19.1.patch")

/**
 * Mirrors the patched connectWallet guard: empty Option → null must not enter
 * the expiry branch (stellar-sdk 16.x).
 */
const signerExpirationIsPresent = (expiration: unknown): boolean =>
	expiration !== undefined && expiration !== null

test.describe("CF12 passkey-kit null-expiry patch", () => {
	test("patched kit.js rejects null expiration the same way as undefined", async () => {
		const kit = await readFile(kitPath, "utf8")
		expect(
			kit,
			"postinstall patch-package must rewrite the connectWallet expiry guard",
		).toMatch(
			/const expiration = signerVal\.values\[1\]\[0\];\s*if \(expiration !== undefined && expiration !== null\) \{/,
		)
		expect(kit).not.toMatch(
			/const expiration = signerVal\.values\[1\]\[0\];\s*if \(expiration !== undefined\) \{/,
		)

		const patch = await readFile(patchPath, "utf8")
		expect(patch).toContain(
			"if (expiration !== undefined && expiration !== null)",
		)
		expect(patch).toContain("-                if (expiration !== undefined) {")
	})

	test("stellar-sdk 16 empty Option decodes as null; patched guard skips toString", () => {
		// Empty Option<u64> → native null (the live Bind failure mode).
		const emptyOption = nativeToScVal(null, { type: "option", inner: "u64" })
		const expiration = scValToNative(emptyOption) as unknown
		expect(expiration).toBeNull()

		expect(signerExpirationIsPresent(expiration)).toBe(false)
		expect(signerExpirationIsPresent(undefined)).toBe(false)
		expect(signerExpirationIsPresent(1n)).toBe(true)

		// Unpatched logic would enter the branch and throw on null.toString().
		const unpatchedWouldEnter = expiration !== undefined
		expect(unpatchedWouldEnter).toBe(true)
		expect(() => {
			if (unpatchedWouldEnter) {
				;(expiration as { toString: () => string }).toString()
			}
		}).toThrow()

		expect(() => {
			if (signerExpirationIsPresent(expiration)) {
				;(expiration as { toString: () => string }).toString()
			}
		}).not.toThrow()
	})
})
