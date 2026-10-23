import { describe, expect, it } from "vitest"
import { money, SettlementError } from "@flexipay/domain"
import {
	PAYER,
	claimSecret,
	codeOf,
	codeOfAsync,
	harness,
	lockRequest,
	usdc,
} from "./settlement-helpers.ts"

describe("mock settlement: shared error codes", () => {
	it("rejects an invalid amount", async () => {
		const { adapter } = harness()

		expect(await codeOfAsync(adapter.fundVault(PAYER, usdc("0")))).toBe(3)
		expect(
			await codeOfAsync(adapter.lock(lockRequest({ amount: usdc("0") }))),
		).toBe(3)
	})

	it("rejects an amount in an asset the vault was not deployed for", async () => {
		const { adapter } = harness()

		expect(
			await codeOfAsync(adapter.fundVault(PAYER, money("100000000", "USD"))),
		).toBe(3)
	})

	it("rejects an expiry that is not after now", async () => {
		const { adapter, clock } = harness()

		expect(
			await codeOfAsync(adapter.lock(lockRequest({ expiresAt: clock.now() }))),
		).toBe(11)
		expect(
			await codeOfAsync(
				adapter.lock(
					lockRequest({
						expiresAt: new Date(clock.now().getTime() - 60_000),
					}),
				),
			),
		).toBe(11)
	})

	it("fails startup when the fixed fee is above 1000 bps", () => {
		expect(codeOf(() => harness({ feeBps: 1001 }))).toBe(4)
		expect(codeOf(() => harness({ feeBps: -1 }))).toBe(4)
		expect(codeOf(() => harness({ feeBps: 1.5 }))).toBe(4)
	})

	it("carries the shared name, number and class", async () => {
		const h = harness()
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
		await h.adapter.lock(lockRequest())

		try {
			await h.adapter.lock(lockRequest())
			expect.unreachable("the duplicate lock must throw")
		} catch (error) {
			expect(error).toBeInstanceOf(SettlementError)
			expect(error).toMatchObject({
				name: "SettlementError",
				code: 12,
				errorName: "DuplicateExternalId",
			})
		}
	})

	it("checks amount, expiry, duplicate and balance in the contract's order", async () => {
		const h = harness()
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
		await h.adapter.lock(lockRequest())

		// Amount first, even with a duplicate id and an expiry in the past.
		expect(
			await codeOfAsync(
				h.adapter.lock(
					lockRequest({
						amount: usdc("0"),
						expiresAt: new Date(h.clock.now().getTime() - 1000),
					}),
				),
			),
		).toBe(3)
		// Expiry before the duplicate check.
		expect(
			await codeOfAsync(
				h.adapter.lock(
					lockRequest({
						expiresAt: new Date(h.clock.now().getTime() - 1000),
					}),
				),
			),
		).toBe(11)
		// Duplicate before the balance check, though this amount could not be covered.
		expect(
			await codeOfAsync(
				h.adapter.lock(lockRequest({ amount: usdc("999999999") })),
			),
		).toBe(12)
	})
})

describe("mock settlement: failed calls preserve state", () => {
	it("creates nothing when a lock is rejected", async () => {
		const { adapter, clock, events } = harness()
		await adapter.fundVault(PAYER, usdc("1000000000"))

		await codeOfAsync(adapter.lock(lockRequest({ expiresAt: clock.now() })))

		expect(events).toHaveLength(0)
		expect(await adapter.findLock(PAYER, "pay_demo_1", 1)).toBeUndefined()
	})

	it("keeps the locked funds after a bad claim and refunds them after expiry", async () => {
		const secret = claimSecret()
		const h = harness()
		await h.adapter.fundVault(PAYER, usdc("200000000"))
		const locked = await h.adapter.lock(
			lockRequest({ claimHashHex: secret.claimHashHex }),
		)

		await codeOfAsync(
			h.adapter.release({
				payoutId: locked.payoutId,
				secretHex: claimSecret().secretHex,
				destination: "GDEMORECIPIENT0000000000000000000000000000000000000",
			}),
		)
		expect((await h.adapter.status(locked.payoutId)).state).toBe("pending")

		h.clock.advanceSeconds(3600)
		await h.adapter.refund(locked.payoutId)
		expect((await h.adapter.status(locked.payoutId)).state).toBe("refunded")
	})

	it("charges no fee when the vault fee is zero", async () => {
		const { adapter } = harness({ feeBps: 0 })
		await adapter.fundVault(PAYER, usdc("100000000"))

		const locked = await adapter.lock(lockRequest())
		expect(locked.fee).toEqual(usdc("0"))
		expect(locked.locked).toEqual(usdc("100000000"))
		expect(locked.net).toEqual(usdc("100000000"))
	})

	it("reads the fee from the vault configuration", async () => {
		expect(await harness().adapter.feeBps()).toBe(100)
		expect(await harness({ feeBps: 250 }).adapter.feeBps()).toBe(250)
	})
})
