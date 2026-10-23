import { describe, expect, it } from "vitest"
import {
	DESTINATION,
	IN_HOUR,
	OTHER_PAYER,
	PAYER,
	claimSecret,
	codeOfAsync,
	harness,
	lockRequest,
	usdc,
} from "./settlement-helpers.ts"

const ATTEMPT_1 =
	"0c21059804ded6a04ed3f96fa1c24c7c4312c194aa59e0f3c9d9ac5476c2a7ca"

describe("mock settlement: instance isolation", () => {
	it("keeps balances and used ids inside one adapter", async () => {
		const a = harness()
		const b = harness()

		await a.adapter.fundVault(PAYER, usdc("1000000000"))
		const locked = await a.adapter.lock(lockRequest())

		expect(await codeOfAsync(b.adapter.lock(lockRequest()))).toBe(5)
		await b.adapter.fundVault(PAYER, usdc("1000000000"))
		const theirs = await b.adapter.lock(lockRequest())

		expect(theirs.payoutId).toBe("1")
		expect(await b.adapter.findLock(PAYER, "pay_demo_1", 1)).toBe("1")
		expect(await a.adapter.findLock(PAYER, "pay_demo_1", 1)).toBe(
			locked.payoutId,
		)
		expect(await codeOfAsync(b.adapter.lock(lockRequest()))).toBe(12)
	})

	it("numbers mock transaction references per adapter and marks them", async () => {
		const a = harness()
		const b = harness()

		expect(await a.adapter.fundVault(PAYER, usdc("1000000000"))).toEqual({
			network: "mock",
			txRef: "mock-tx-1",
		})
		expect(await b.adapter.fundVault(OTHER_PAYER, usdc("1000000000"))).toEqual({
			network: "mock",
			txRef: "mock-tx-1",
		})
		const locked = await a.adapter.lock(lockRequest())
		expect(locked.txRef).toBe("mock-tx-2")
	})
})

describe("mock settlement: events", () => {
	it("emits created, claimed and refunded with the contract's data", async () => {
		const secret = claimSecret()
		const h = harness()
		await h.adapter.fundVault(PAYER, usdc("1000000000"))

		const claimed = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)
		await h.adapter.release({
			payoutId: claimed.payoutId,
			secretHex: secret.secretHex,
			destination: DESTINATION,
		})

		const refunded = await h.adapter.lock(lockRequest({ attempt: 2 }))
		h.clock.set(IN_HOUR)
		await h.adapter.refund(refunded.payoutId)

		expect(h.events).toHaveLength(4)
		expect(h.events[0]).toMatchObject({
			type: "payout_created",
			simulated: true,
			payoutId: claimed.payoutId,
			payer: PAYER,
			externalIdHex: ATTEMPT_1,
			gross: usdc("100000000"),
			fee: usdc("1000000"),
			net: usdc("100000000"),
			expiresAt: IN_HOUR,
		})
		expect(h.events[1]).toMatchObject({
			type: "payout_claimed",
			simulated: true,
			payoutId: claimed.payoutId,
			destination: DESTINATION,
			net: usdc("100000000"),
			fee: usdc("1000000"),
		})
		expect(h.events[2]).toMatchObject({
			type: "payout_created",
			payoutId: refunded.payoutId,
		})
		expect(h.events[3]).toMatchObject({
			type: "payout_refunded",
			simulated: true,
			payoutId: refunded.payoutId,
			payer: PAYER,
			amount: usdc("101000000"),
			cancelled: false,
		})
	})

	it("emits nothing for a rejected call", async () => {
		const h = harness()
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
		const locked = await h.adapter.lock(lockRequest())

		await codeOfAsync(
			h.adapter.release({
				payoutId: locked.payoutId,
				secretHex: claimSecret().secretHex,
				destination: "GDEMOWRONG",
			}),
		)
		await codeOfAsync(h.adapter.lock(lockRequest()))

		expect(h.events.map((e) => e.type)).toEqual(["payout_created"])
	})
})

describe("mock settlement: clock and status", () => {
	it("uses only the supplied clock for expiry", async () => {
		const h = harness()
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
		const secret = claimSecret()
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)

		// The wall clock says nothing about this expiry: only h.clock.advanceSeconds moves it.
		const status = await h.adapter.status(locked.payoutId)
		expect(status).toEqual({
			payoutId: locked.payoutId,
			state: "pending",
			expiresAt: IN_HOUR,
			net: usdc("100000000"),
		})

		h.clock.advanceSeconds(3600)
		expect(
			await codeOfAsync(
				h.adapter.release({
					payoutId: locked.payoutId,
					secretHex: secret.secretHex,
					destination: DESTINATION,
				}),
			),
		).toBe(8)
	})
})
