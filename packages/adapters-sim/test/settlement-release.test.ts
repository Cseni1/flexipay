import { beforeEach, describe, expect, it } from "vitest"
import {
	DESTINATION,
	IN_HOUR,
	PAYER,
	claimSecret,
	codeOfAsync,
	harness,
	lockRequest,
	usdc,
	type Harness,
} from "./settlement-helpers.ts"

let h: Harness

beforeEach(async () => {
	h = harness()
	await h.adapter.fundVault(PAYER, usdc("1000000000"))
})

describe("mock settlement: claim", () => {
	it("releases the net to the destination and reports the state", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)

		const released = await h.adapter.release({
			payoutId: locked.payoutId,
			secretHex: secret.secretHex,
			destination: DESTINATION,
		})

		expect(released.received).toEqual(usdc("100000000"))
		expect(released.network).toBe("mock")
		expect(released.txRef).toBe("mock-tx-3")

		const status = await h.adapter.status(locked.payoutId)
		expect(status).toEqual({
			payoutId: locked.payoutId,
			state: "claimed",
			expiresAt: IN_HOUR,
			net: usdc("100000000"),
		})
	})

	it("rejects a bad secret and leaves the payout claimable", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)

		expect(
			await codeOfAsync(
				h.adapter.release({
					payoutId: locked.payoutId,
					secretHex: claimSecret().secretHex,
					destination: DESTINATION,
				}),
			),
		).toBe(10)
		expect((await h.adapter.status(locked.payoutId)).state).toBe("pending")

		const released = await h.adapter.release({
			payoutId: locked.payoutId,
			secretHex: secret.secretHex,
			destination: DESTINATION,
		})
		expect(released.received).toEqual(usdc("100000000"))
	})

	it("refuses a claim at exactly expires_at", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)
		h.clock.set(IN_HOUR)

		expect(
			await codeOfAsync(
				h.adapter.release({
					payoutId: locked.payoutId,
					secretHex: secret.secretHex,
					destination: DESTINATION,
				}),
			),
		).toBe(8)
		expect((await h.adapter.status(locked.payoutId)).state).toBe("pending")
	})

	it("claims one second before expiry", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)
		h.clock.set(new Date(IN_HOUR.getTime() - 1000))

		const released = await h.adapter.release({
			payoutId: locked.payoutId,
			secretHex: secret.secretHex,
			destination: DESTINATION,
		})
		expect(released.received).toEqual(usdc("100000000"))
	})

	it("refuses a second claim", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)
		await h.adapter.release({
			payoutId: locked.payoutId,
			secretHex: secret.secretHex,
			destination: DESTINATION,
		})

		expect(
			await codeOfAsync(
				h.adapter.release({
					payoutId: locked.payoutId,
					secretHex: secret.secretHex,
					destination: DESTINATION,
				}),
			),
		).toBe(7)
	})
})

describe("mock settlement: refund", () => {
	it("cancels a pending payout before expiry and returns the locked amount", async () => {
		const locked = await h.adapter.lock(lockRequest())
		h.events.length = 0

		await h.adapter.refund(locked.payoutId)

		expect((await h.adapter.status(locked.payoutId)).state).toBe("refunded")
		expect(h.events).toMatchObject([
			{ type: "payout_refunded", cancelled: true, amount: locked.locked },
		])
		// the locked amount is back: the same payment can lock again with attempt 2
		await h.adapter.lock(lockRequest({ attempt: 2 }))
		// and attempt 1 stays used for good
		expect(await codeOfAsync(h.adapter.lock(lockRequest()))).toBe(12)
	})

	it("reports an expiry refund as not cancelled", async () => {
		const locked = await h.adapter.lock(lockRequest())
		h.clock.set(IN_HOUR)
		h.events.length = 0

		await h.adapter.refund(locked.payoutId)

		expect(h.events).toMatchObject([
			{ type: "payout_refunded", cancelled: false },
		])
	})

	it("does not refund a claimed payout", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)
		await h.adapter.release({
			payoutId: locked.payoutId,
			secretHex: secret.secretHex,
			destination: DESTINATION,
		})

		expect(await codeOfAsync(h.adapter.refund(locked.payoutId))).toBe(7)
	})

	it("refunds at exactly expires_at and returns the locked amount", async () => {
		const locked = await h.adapter.lock(lockRequest())
		h.clock.set(IN_HOUR)

		expect(await h.adapter.refund(locked.payoutId)).toEqual({
			network: "mock",
			txRef: "mock-tx-3",
		})
		expect((await h.adapter.status(locked.payoutId)).state).toBe("refunded")

		// The refunded balance is disposable again: a fresh attempt can lock the same amount.
		await h.adapter.lock(
			lockRequest({
				attempt: 2,
				expiresAt: new Date(IN_HOUR.getTime() + 3_600_000),
			}),
		)
	})

	it("refuses a second refund and a claim after a refund", async () => {
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)
		h.clock.advanceSeconds(3600)
		await h.adapter.refund(locked.payoutId)

		expect(await codeOfAsync(h.adapter.refund(locked.payoutId))).toBe(7)
		expect(
			await codeOfAsync(
				h.adapter.release({
					payoutId: locked.payoutId,
					secretHex: secret.secretHex,
					destination: DESTINATION,
				}),
			),
		).toBe(7)
	})

	it("rejects an unknown payout", async () => {
		expect(await codeOfAsync(h.adapter.refund("99"))).toBe(6)
		expect(await codeOfAsync(h.adapter.status("99"))).toBe(6)
		expect(
			await codeOfAsync(
				h.adapter.release({
					payoutId: "99",
					secretHex: claimSecret().secretHex,
					destination: DESTINATION,
				}),
			),
		).toBe(6)
	})
})
