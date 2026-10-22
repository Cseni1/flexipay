import { describe, expect, it } from "vitest"
import type { FeeMode } from "@flexipay/domain"
import { lockExternalIdHex } from "../src/hash.ts"
import {
	MockVault,
	type CreatePayoutRequest,
	type MockVaultEvent,
	type MockVaultOptions,
} from "../src/vault.ts"
import {
	FEE_BPS,
	IN_HOUR,
	PAYER,
	TOKEN,
	TREASURY,
	claimSecret,
	codeOf,
	demoClock,
	usdc,
} from "./settlement-helpers.ts"

// The vault's views and payer-side operations have no path through SettlementAdapter, so they are
// exercised directly. They are still the contract's rules: the adapter relies on this state.

function vault(over: Partial<MockVaultOptions> = {}) {
	const clock = demoClock()
	const events: MockVaultEvent[] = []
	const instance = new MockVault({
		token: TOKEN,
		treasury: TREASURY,
		feeBps: FEE_BPS,
		now: clock.now,
		onEvent: (event) => events.push(event),
		...over,
	})
	return { clock, events, vault: instance }
}

function request(over: Partial<CreatePayoutRequest> = {}): CreatePayoutRequest {
	return {
		payer: PAYER,
		externalIdHex: lockExternalIdHex("pay_demo_1", 1),
		claimHashHex: claimSecret().claimHashHex,
		amount: usdc("100000000"),
		feeMode: "PayerPays" as FeeMode,
		expiresAt: IN_HOUR,
		...over,
	}
}

describe("mock vault: balances", () => {
	it("deposits, reports the balance and withdraws unlocked funds", () => {
		const { vault: v } = vault()
		v.deposit(PAYER, usdc("200000000"))
		expect(v.balance(PAYER)).toEqual(usdc("200000000"))

		v.withdraw(PAYER, usdc("50000000"))
		expect(v.balance(PAYER)).toEqual(usdc("150000000"))
	})

	it("refuses an invalid or uncovered withdrawal", () => {
		const { vault: v } = vault()
		v.deposit(PAYER, usdc("100000000"))

		expect(codeOf(() => v.withdraw(PAYER, usdc("0")))).toBe(3)
		expect(codeOf(() => v.withdraw(PAYER, usdc("100000001")))).toBe(5)
		expect(v.balance(PAYER)).toEqual(usdc("100000000"))
	})

	it("cannot withdraw funds locked in a payout", () => {
		const { vault: v } = vault()
		v.deposit(PAYER, usdc("101000000"))
		v.createPayout(request())

		expect(v.balance(PAYER)).toEqual(usdc("0"))
		expect(codeOf(() => v.withdraw(PAYER, usdc("1")))).toBe(5)
	})
})

describe("mock vault: cancellation", () => {
	it("cancels a pending payout before expiry and returns the locked amount", () => {
		const { vault: v, events } = vault()
		v.deposit(PAYER, usdc("101000000"))
		const payout = v.createPayout(request())
		expect(v.balance(PAYER)).toEqual(usdc("0"))

		const cancelled = v.cancel(payout.id)

		expect(cancelled.status).toBe("Refunded")
		expect(v.balance(PAYER)).toEqual(usdc("101000000"))
		expect(events[1]).toMatchObject({
			type: "payout_refunded",
			payoutId: payout.id,
			payer: PAYER,
			amount: usdc("101000000"),
			cancelled: true,
		})
	})

	it("keeps the external id used after a cancel", () => {
		const { vault: v } = vault()
		v.deposit(PAYER, usdc("300000000"))
		const payout = v.createPayout(request())
		v.cancel(payout.id)

		expect(v.payoutByExternal(PAYER, payout.externalIdHex)).toBe(payout.id)
		expect(codeOf(() => v.createPayout(request()))).toBe(12)
	})

	it("refuses a cancel of a payout that is no longer pending", () => {
		const secret = claimSecret()
		const { vault: v } = vault()
		v.deposit(PAYER, usdc("101000000"))
		const payout = v.createPayout(
			request({ claimHashHex: secret.claimHashHex }),
		)
		v.claim(
			payout.id,
			secret.secretHex,
			"GDEMORECIPIENT0000000000000000000000000000000000000",
		)

		expect(codeOf(() => v.cancel(payout.id))).toBe(7)
	})
})

describe("mock vault: views and state", () => {
	it("numbers payouts from 1 and keeps them readable", () => {
		const { vault: v } = vault()
		v.deposit(PAYER, usdc("500000000"))

		const first = v.createPayout(request())
		const second = v.createPayout(
			request({ externalIdHex: lockExternalIdHex("pay_demo_1", 2) }),
		)
		const third = v.createPayout(
			request({ externalIdHex: lockExternalIdHex("pay_demo_1", 3) }),
		)

		expect([first.id, second.id, third.id]).toEqual(["1", "2", "3"])
		expect(v.getPayout("2")).toMatchObject({
			payer: PAYER,
			gross: usdc("100000000"),
			fee: usdc("1000000"),
			net: usdc("100000000"),
			locked: usdc("101000000"),
			status: "Pending",
		})
	})

	it("returns the deployment settings and nothing mutable", () => {
		const { vault: v } = vault()
		const config = v.config()
		config.feeBps = 5000

		expect(v.config()).toEqual({
			token: TOKEN,
			treasury: TREASURY,
			feeBps: FEE_BPS,
		})
	})

	it("stores the claim hash and pays the fee on a claim", () => {
		const secret = claimSecret()
		const { vault: v } = vault({ feeBps: 0 })
		v.deposit(PAYER, usdc("100000000"))
		const payout = v.createPayout(
			request({ claimHashHex: secret.claimHashHex }),
		)

		expect(
			v.claim(
				payout.id,
				secret.secretHex,
				"GDEMORECIPIENT0000000000000000000000000000000000000",
			),
		).toEqual(usdc("100000000"))
		expect(v.getPayout(payout.id).status).toBe("Claimed")
	})
})
