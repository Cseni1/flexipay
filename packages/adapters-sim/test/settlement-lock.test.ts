import { beforeEach, describe, expect, it } from "vitest"
import { lockExternalIdHex } from "../src/hash.ts"
import {
	IN_HOUR,
	OTHER_PAYER,
	PAYER,
	codeOfAsync,
	harness,
	lockRequest,
	usdc,
	type Harness,
} from "./settlement-helpers.ts"

// RULES.md amounts are integers in the token's smallest unit; test USDC has 7 decimals, so
// 100000000 is 10 USDC and a 1% fee is 1000000. The two digests below are the exact SHA-256 of
// "pay_demo_1:1" and "pay_demo_1:2", computed independently of this package.

const ATTEMPT_1 =
	"0c21059804ded6a04ed3f96fa1c24c7c4312c194aa59e0f3c9d9ac5476c2a7ca"
const ATTEMPT_2 =
	"a6787b0ff947203983c972236921ced5e02692155e806ac6b1da9bfbe4562f6d"

let h: Harness

beforeEach(() => {
	h = harness()
})

describe("mock settlement: funding and balances", () => {
	it("moves the funded amount into the payer's vault balance", async () => {
		const funded = await h.adapter.fundVault(PAYER, usdc("101000000"))

		expect(funded).toEqual({ network: "mock", txRef: "mock-tx-1" })
		const result = await h.adapter.lock(lockRequest())
		expect(result.locked).toEqual(usdc("101000000"))
	})

	it("refuses a lock the funded balance cannot cover", async () => {
		await h.adapter.fundVault(PAYER, usdc("100000000"))

		expect(await codeOfAsync(h.adapter.lock(lockRequest()))).toBe(5)
		expect(await h.adapter.findLock(PAYER, "pay_demo_1", 1)).toBeUndefined()

		await h.adapter.fundVault(PAYER, usdc("1000000"))
		const retried = await h.adapter.lock(lockRequest())
		expect(retried.locked).toEqual(usdc("101000000"))
	})

	it("keeps the balance after a lock down by exactly the locked amount", async () => {
		await h.adapter.fundVault(PAYER, usdc("200000000"))
		await h.adapter.lock(lockRequest())

		expect(await codeOfAsync(h.adapter.lock(lockRequest({ attempt: 2 })))).toBe(
			5,
		)
	})
})

describe("mock settlement: fee modes", () => {
	beforeEach(async () => {
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
	})

	it("takes the fee from the payer in PayerPays", async () => {
		const result = await h.adapter.lock(lockRequest({ feeMode: "PayerPays" }))

		expect(result.fee).toEqual(usdc("1000000"))
		expect(result.locked).toEqual(usdc("101000000"))
		expect(result.net).toEqual(usdc("100000000"))
	})

	it("takes the fee from the recipient in RecipientPays", async () => {
		const result = await h.adapter.lock(
			lockRequest({ feeMode: "RecipientPays" }),
		)

		expect(result.fee).toEqual(usdc("1000000"))
		expect(result.locked).toEqual(usdc("100000000"))
		expect(result.net).toEqual(usdc("99000000"))
	})

	it("rounds the fee down", async () => {
		const result = await h.adapter.lock(
			lockRequest({ amount: usdc("199"), feeMode: "RecipientPays" }),
		)

		expect(result.fee).toEqual(usdc("1"))
		expect(result.net).toEqual(usdc("198"))
	})
})

describe("mock settlement: per-attempt external id", () => {
	beforeEach(async () => {
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
	})

	it("derives the 32-byte digest of <payment id>:<attempt>", async () => {
		const first = await h.adapter.lock(lockRequest({ attempt: 1 }))
		const second = await h.adapter.lock(lockRequest({ attempt: 2 }))

		expect(first.externalIdHex).toBe(ATTEMPT_1)
		expect(second.externalIdHex).toBe(ATTEMPT_2)
		expect(first.externalIdHex).toHaveLength(64)
		expect(lockExternalIdHex("pay_demo_1", 1)).toBe(ATTEMPT_1)
		expect(lockExternalIdHex("pay_demo_1", 2)).toBe(ATTEMPT_2)
	})

	it("recovers the lock by payer, payment and attempt", async () => {
		const locked = await h.adapter.lock(lockRequest())

		expect(await h.adapter.findLock(PAYER, "pay_demo_1", 1)).toBe(
			locked.payoutId,
		)
		expect(await h.adapter.findLock(PAYER, "pay_demo_1", 2)).toBeUndefined()
		expect(
			await h.adapter.findLock(OTHER_PAYER, "pay_demo_1", 1),
		).toBeUndefined()
	})

	it("rejects a second lock with the same external id", async () => {
		const locked = await h.adapter.lock(lockRequest())

		expect(await codeOfAsync(h.adapter.lock(lockRequest()))).toBe(12)
		expect(await h.adapter.findLock(PAYER, "pay_demo_1", 1)).toBe(
			locked.payoutId,
		)
		expect((await h.adapter.status(locked.payoutId)).state).toBe("pending")
	})

	it("lets another payer use the same payment id and attempt", async () => {
		await h.adapter.fundVault(OTHER_PAYER, usdc("1000000000"))

		const mine = await h.adapter.lock(lockRequest())
		const theirs = await h.adapter.lock(lockRequest({ payer: OTHER_PAYER }))

		expect(theirs.payoutId).not.toBe(mine.payoutId)
		expect(await h.adapter.findLock(OTHER_PAYER, "pay_demo_1", 1)).toBe(
			theirs.payoutId,
		)
	})
})

describe("mock settlement: refund and retry", () => {
	beforeEach(async () => {
		await h.adapter.fundVault(PAYER, usdc("1000000000"))
	})

	it("keeps the external id used after a refund and locks the retry with attempt 2", async () => {
		const first = await h.adapter.lock(lockRequest({ attempt: 1 }))
		h.clock.advanceSeconds(3600)
		await h.adapter.refund(first.payoutId)

		const later = new Date(IN_HOUR.getTime() + 3_600_000)
		expect(
			await codeOfAsync(h.adapter.lock(lockRequest({ expiresAt: later }))),
		).toBe(12)

		const retry = await h.adapter.lock(
			lockRequest({ attempt: 2, expiresAt: later }),
		)
		expect(retry.externalIdHex).toBe(ATTEMPT_2)
		expect(retry.payoutId).toBe("2")
		expect(await h.adapter.findLock(PAYER, "pay_demo_1", 2)).toBe(
			retry.payoutId,
		)
	})

	it("does not consume the external id when the lock is rejected", async () => {
		expect(
			await codeOfAsync(
				h.adapter.lock(
					lockRequest({ expiresAt: new Date(h.clock.now().getTime()) }),
				),
			),
		).toBe(11)

		const locked = await h.adapter.lock(lockRequest())
		expect(locked.externalIdHex).toBe(ATTEMPT_1)
		expect(await h.adapter.findLock(PAYER, "pay_demo_1", 1)).toBe(
			locked.payoutId,
		)
	})
})
