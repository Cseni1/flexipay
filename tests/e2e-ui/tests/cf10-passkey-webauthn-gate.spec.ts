import { expect, test } from "@playwright/test"
import { createPasskeyWebAuthnGate } from "../../../apps/web/src/api/passkeyWebAuthnGate.ts"

// Proves the gated WebAuthn wrapper itself (not a full kit fixture). Fixture PASS here is not
// a real authenticator ceremony.

const regOptions = { challenge: "reg-challenge" }
const authOptions = {
	challenge: "auth-challenge",
	rpId: "localhost",
	allowCredentials: [{ id: "cred-1", type: "public-key" }],
}
const regResponse = { id: "cred-1" }
const authResponse = {
	id: "cred-1",
	rawId: "cred-1",
	response: {},
	type: "public-key",
}

test.describe("CF10 WebAuthn creation gate (wrapper)", () => {
	test("registration then park: zero real authentications until Confirm click", async () => {
		let registrations = 0
		let authentications = 0
		const authCalls: unknown[] = []

		const gate = createPasskeyWebAuthnGate({
			startRegistration: async () => {
				registrations += 1
				return regResponse
			},
			startAuthentication: async (args) => {
				authentications += 1
				authCalls.push(args.optionsJSON)
				return authResponse
			},
		})

		gate.beginCreationGate()
		const reg = await gate.client.startRegistration({ optionsJSON: regOptions })
		expect(reg.id).toBe("cred-1")
		expect(registrations).toBe(1)
		expect(authentications).toBe(0)
		expect(gate.snapshot().phase).toBe("idle")

		let settled = false
		const parked = gate.client.startAuthentication({ optionsJSON: authOptions }).then(
			(value) => {
				settled = true
				return value
			},
		)
		await expect.poll(() => gate.snapshot().phase).toBe("awaiting_confirm")
		expect(authentications).toBe(0)
		expect(gate.snapshot().hasParkedOptions).toBe(true)
		expect(settled).toBe(false)

		const outcome = await gate.confirmCreationAuthentication()
		expect(outcome).toBe("completed")
		await expect(parked).resolves.toEqual(authResponse)
		expect(authentications).toBe(1)
		expect(authCalls).toHaveLength(1)
		expect(registrations).toBe(1)
	})

	test("each Confirm click runs at most one authentication; double-click is busy", async () => {
		let authentications = 0
		let releaseAuth: (() => void) | null = null

		const gate = createPasskeyWebAuthnGate({
			startRegistration: async () => regResponse,
			startAuthentication: () =>
				new Promise((resolve) => {
					authentications += 1
					releaseAuth = () => resolve(authResponse)
				}),
		})

		gate.beginCreationGate()
		const parked = gate.client.startAuthentication({ optionsJSON: authOptions })
		await expect.poll(() => gate.snapshot().phase).toBe("awaiting_confirm")

		const first = gate.confirmCreationAuthentication()
		await expect.poll(() => authentications).toBe(1)
		const second = await gate.confirmCreationAuthentication()
		expect(second).toBe("busy")
		expect(authentications).toBe(1)

		releaseAuth?.()
		await expect(first).resolves.toBe("completed")
		await expect(parked).resolves.toEqual(authResponse)
		expect(authentications).toBe(1)
	})

	test("dismiss keeps the same parked options; Confirm retries without new registration", async () => {
		let registrations = 0
		let authentications = 0
		let failOnce = true

		const gate = createPasskeyWebAuthnGate({
			startRegistration: async () => {
				registrations += 1
				return regResponse
			},
			startAuthentication: async () => {
				authentications += 1
				if (failOnce) {
					failOnce = false
					const err = new Error("user dismissed")
					err.name = "NotAllowedError"
					throw err
				}
				return authResponse
			},
		})

		gate.beginCreationGate()
		await gate.client.startRegistration({ optionsJSON: regOptions })
		const parked = gate.client.startAuthentication({ optionsJSON: authOptions })
		await expect.poll(() => gate.snapshot().phase).toBe("awaiting_confirm")

		expect(await gate.confirmCreationAuthentication()).toBe("dismissed")
		expect(gate.snapshot().phase).toBe("dismissed")
		expect(gate.snapshot().hasParkedOptions).toBe(true)
		expect(registrations).toBe(1)
		expect(authentications).toBe(1)

		expect(await gate.confirmCreationAuthentication()).toBe("completed")
		await expect(parked).resolves.toEqual(authResponse)
		expect(registrations).toBe(1)
		expect(authentications).toBe(2)
	})

	test("get failure keeps parked options for Confirm retry", async () => {
		let authentications = 0
		let failOnce = true

		const gate = createPasskeyWebAuthnGate({
			startRegistration: async () => regResponse,
			startAuthentication: async () => {
				authentications += 1
				if (failOnce) {
					failOnce = false
					throw new Error("authenticator error")
				}
				return authResponse
			},
		})

		gate.beginCreationGate()
		const parked = gate.client.startAuthentication({ optionsJSON: authOptions })
		await expect.poll(() => gate.snapshot().phase).toBe("awaiting_confirm")

		expect(await gate.confirmCreationAuthentication()).toBe("failed")
		expect(gate.snapshot().hasParkedOptions).toBe(true)
		expect(await gate.confirmCreationAuthentication()).toBe("completed")
		await expect(parked).resolves.toEqual(authResponse)
		expect(authentications).toBe(2)
	})

	test("outside the creation gate authentication is passthrough", async () => {
		let authentications = 0
		const gate = createPasskeyWebAuthnGate({
			startRegistration: async () => regResponse,
			startAuthentication: async () => {
				authentications += 1
				return authResponse
			},
		})

		const direct = await gate.client.startAuthentication({
			optionsJSON: authOptions,
		})
		expect(direct).toEqual(authResponse)
		expect(authentications).toBe(1)
		expect(gate.snapshot().hasParkedOptions).toBe(false)
	})

	test("abandon rejects the parked createWallet authentication", async () => {
		const gate = createPasskeyWebAuthnGate({
			startRegistration: async () => regResponse,
			startAuthentication: async () => authResponse,
		})
		gate.beginCreationGate()
		const parked = gate.client.startAuthentication({ optionsJSON: authOptions })
		await expect.poll(() => gate.snapshot().phase).toBe("awaiting_confirm")
		gate.abandonCreationAuthentication()
		await expect(parked).rejects.toThrow(/cancelled/i)
		expect(gate.snapshot().hasParkedOptions).toBe(false)
	})
})
