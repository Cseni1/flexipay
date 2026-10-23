import { createHash } from "node:crypto"
import {
	money,
	SettlementError,
	type LockRequest,
	type Money,
} from "@flexipay/domain"
import {
	MockSettlementAdapter,
	type MockSettlementOptions,
	type MockVaultEvent,
} from "../src/index.ts"

// Fixtures for the mock settlement tests. Addresses are synthetic demo strings, secrets are made
// in memory, and the clock is ours, so nothing here reads the wall clock or a secret file.

export const TOKEN = "USDC"
export const TREASURY = "GDEMOTREASURY0000000000000000000000000000000000000000"
export const PAYER = "GDEMOPAYER00000000000000000000000000000000000000000"
export const OTHER_PAYER = "GDEMOOTHERPAYER000000000000000000000000000000000000"
export const DESTINATION = "GDEMORECIPIENT0000000000000000000000000000000000000"
export const T0 = new Date("2026-10-22T12:00:00.000Z")
export const IN_HOUR = new Date(T0.getTime() + 3_600_000)
export const FEE_BPS = 100

export const usdc = (amount: string): Money => money(amount, TOKEN)

export function demoClock(start: Date = T0) {
	let current = start
	return {
		now: () => current,
		set(date: Date) {
			current = date
		},
		advanceSeconds(seconds: number) {
			current = new Date(current.getTime() + seconds * 1000)
		},
	}
}

export interface Harness {
	adapter: MockSettlementAdapter
	clock: ReturnType<typeof demoClock>
	events: MockVaultEvent[]
	options: MockSettlementOptions
}

/** A fresh adapter, clock and event log per test, so no state or override leaks between them. */
export function harness(over: Partial<MockSettlementOptions> = {}): Harness {
	const clock = demoClock()
	const events: MockVaultEvent[] = []
	const options: MockSettlementOptions = {
		token: TOKEN,
		treasury: TREASURY,
		feeBps: FEE_BPS,
		now: clock.now,
		onEvent: (event) => events.push(event),
		...over,
	}
	return {
		adapter: new MockSettlementAdapter(options),
		clock,
		events,
		options,
	}
}

let secrets = 0

/** A synthetic claim secret and its hash, generated in memory for one test only. */
export function claimSecret(): { secretHex: string; claimHashHex: string } {
	const bytes = createHash("sha256")
		.update(`demo-claim-${++secrets}`, "utf8")
		.digest()
	return {
		secretHex: bytes.toString("hex"),
		claimHashHex: createHash("sha256").update(bytes).digest("hex"),
	}
}

export function lockRequest(over: Partial<LockRequest> = {}): LockRequest {
	return {
		paymentId: "pay_demo_1",
		attempt: 1,
		payer: PAYER,
		amount: usdc("100000000"),
		feeMode: "PayerPays",
		expiresAt: IN_HOUR,
		claimHashHex: claimSecret().claimHashHex,
		...over,
	}
}

/** The shared settlement code a synchronous call throws, or a description of what happened. */
export function codeOf(run: () => unknown): number | string {
	try {
		run()
	} catch (error) {
		return error instanceof SettlementError
			? error.code
			: `not a SettlementError: ${String(error)}`
	}
	return "no error"
}

export async function codeOfAsync(
	pending: Promise<unknown>,
): Promise<number | string> {
	try {
		await pending
	} catch (error) {
		return error instanceof SettlementError
			? error.code
			: `not a SettlementError: ${String(error)}`
	}
	return "no error"
}
