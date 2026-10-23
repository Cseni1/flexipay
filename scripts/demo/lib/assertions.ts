import type { FeeMode, LegKind, PaymentStatus } from "@flexipay/domain"
import { fail, record } from "./parse.ts"
import type {
	EventView,
	LegView,
	MoneyView,
	PaymentView,
	QuoteView,
} from "./types.ts"

// Flow assertions over the semantic view. The shape parsers live in parse.ts and are re-exported
// here so scripts and self-tests keep one import site.

export {
	AssertionFailure,
	events,
	fail,
	integerString,
	leg,
	list,
	money,
	payment,
	quote,
	record,
	text,
} from "./parse.ts"

export const kindsOf = (legs: readonly LegView[]): LegKind[] =>
	legs.map((l) => l.kind)

export function expectKinds(
	seen: readonly LegKind[],
	expected: readonly LegKind[],
	where: string,
): void {
	if (seen.join(",") !== expected.join(",")) {
		fail(
			`${where}: leg kinds ${seen.join(" > ") || "(none)"}, expected ${expected.join(" > ")}`,
		)
	}
}

export function expectLegKinds(
	legs: readonly LegView[],
	expected: readonly LegKind[],
	where: string,
): void {
	expectKinds(kindsOf(legs), expected, where)
}

export function expectRouteRail(
	route: readonly { kind: LegKind; rail?: string }[],
	kind: LegKind,
	rail: string,
	where: string,
): void {
	const matching = route.filter((leg) => leg.kind === kind)
	if (matching.length === 0) fail(`${where}: quoted route has no ${kind} leg`)
	if (matching.some((leg) => leg.rail !== rail)) {
		fail(
			`${where}: quoted ${kind} rail ${matching.map((leg) => leg.rail ?? "(none)").join(", ")}, expected ${rail}`,
		)
	}
}

export function expectStatus(
	p: PaymentView,
	allowed: readonly PaymentStatus[],
	where: string,
): void {
	if (!allowed.includes(p.status)) {
		fail(
			`${where}: payment ${p.id} is ${p.status}, expected ${allowed.join(" or ")}`,
		)
	}
}

export function expectPaid(p: PaymentView): void {
	expectStatus(p, ["paid"], "payment")
	const unfinished = p.legs.filter((l) => l.status !== "succeeded")
	if (unfinished.length > 0) {
		fail(
			`payment ${p.id} is paid but legs are not all succeeded: ${unfinished.map((l) => `${l.kind}:${l.status}`).join(", ")}`,
		)
	}
	const last = p.legs.at(-1)
	if (!last) fail(`payment ${p.id} is paid with no legs`)
	// A claim-link crypto route ends at settle; every other route ends at payout (ARCHITECTURE §7).
	if (last.kind !== "payout" && last.kind !== "settle") {
		fail(
			`payment ${p.id} is paid but its last leg is ${last.kind}, not payout or settle`,
		)
	}
}

/** DF3: funding must stop before release, so the settle leg cannot have succeeded yet. */
export function expectWaitingForClaim(p: PaymentView): void {
	if (p.status === "paid")
		fail(`payment ${p.id} is paid before the claim was accepted`)
	const settle = p.legs.find((l) => l.kind === "settle")
	if (!settle) fail(`payment ${p.id} has no settle leg to wait on`)
	if (settle.status === "succeeded") {
		fail(
			`payment ${p.id} released the funds before acceptance (settle succeeded)`,
		)
	}
	if (p.legs.some((l) => l.kind === "payout")) {
		fail(`claim-link crypto payment ${p.id} must not have a payout leg`)
	}
}

export function expectNoSettle(legs: readonly LegView[], where: string): void {
	if (legs.some((l) => l.kind === "settle")) {
		fail(
			`${where}: unexpected settle leg on a corridor without a settlement rail`,
		)
	}
}

export function expectNoPayout(legs: readonly LegView[], where: string): void {
	if (legs.some((l) => l.kind === "payout"))
		fail(`${where}: crypto claim route must end at settle, not payout`)
}

export function expectRail(
	legs: readonly LegView[],
	kind: LegKind,
	rail: string,
	where: string,
): void {
	const matching = legs.filter((l) => l.kind === kind)
	if (matching.length === 0) fail(`${where}: no ${kind} leg`)
	if (matching.some((l) => l.rail !== rail)) {
		fail(
			`${where}: ${kind} rail ${matching.map((l) => l.rail).join(", ")}, expected ${rail}`,
		)
	}
}

const minor = (m: MoneyView, where: string): bigint => {
	if (!/^(0|[1-9][0-9]*)$/.test(m.amount))
		fail(`${where}: expected integer minor units, got "${m.amount}"`)
	return BigInt(m.amount)
}

const sameMoney = (a: MoneyView, b: MoneyView): boolean =>
	a.amount === b.amount && a.currency === b.currency

function expectMoneyEqual(
	seen: MoneyView | undefined,
	expected: MoneyView,
	where: string,
): void {
	if (!seen) fail(`${where}: missing amount`)
	if (!sameMoney(seen, expected)) {
		fail(
			`${where}: ${seen.amount} ${seen.currency}, expected ${expected.amount} ${expected.currency}`,
		)
	}
}

/**
 * CCR-12: settle.externalRef is the contract payoutId, never a transaction hash. CCR-12
 * documents a decimal string; the Stellar adapter returns `receipt.result.toString()` from the
 * vault u64. This check mirrors that wire format — it does not invent a separate id scheme.
 */
export function expectPayoutId(ref: string | undefined, where: string): string {
	if (ref === undefined) fail(`${where}: no settle payoutId`)
	if (!/^[1-9][0-9]*$/.test(ref)) {
		fail(`${where}: "${ref}" is not a positive decimal payoutId`)
	}
	return ref
}

/**
 * CCR-13: PayerPays must size `P = floor(A * 10000 / (10000 + bps))` with
 * `f(P) = floor(P * bps / 10000)` equal to the quoted settle fee.
 *
 * When `vaultFeeBps` is supplied (deployed vault evidence from `testnet-ids.env`), that bps is
 * authoritative and must match the frozen quote. When omitted (mock), the frozen quote amounts
 * and fee must be consistent with some vault bps in 0..1000 — never a caller-chosen
 * `FP_VAULT_FEE_BPS` env on the acceptance process.
 */
export function expectPayerPaysSizing(
	quote: QuoteView,
	vaultFeeBpsOrWhere?: number | string,
	whereArg = "CCR-13",
): void {
	const vaultFeeBps =
		typeof vaultFeeBpsOrWhere === "number" ? vaultFeeBpsOrWhere : undefined
	const where =
		typeof vaultFeeBpsOrWhere === "string" ? vaultFeeBpsOrWhere : whereArg
	if (quote.feeMode !== "PayerPays") return
	const index = quote.route.findIndex((leg) => leg.kind === "settle")
	if (index < 0) return
	const planned = quote.route[index]
	if (!planned?.amountIn) fail(`${where}: quoted settle leg has no principal`)
	if (index === 0)
		fail(`${where}: settle is the first leg, so there is no amount A`)
	const available = quote.route[index - 1]?.amountOut
	if (!available) fail(`${where}: the leg before settle has no amountOut`)
	if (available.currency !== planned.amountIn.currency) {
		fail(`${where}: pre-settle amount and principal use different assets`)
	}
	const fees = quote.fees
	if (!fees) fail(`${where}: quote has no fee breakdown`)
	const a = minor(available, `${where}: available`)
	const p = minor(planned.amountIn, `${where}: principal`)
	const fee = minor(fees.flexiPayFee, `${where}: fee`)

	if (vaultFeeBps !== undefined) {
		if (
			!Number.isInteger(vaultFeeBps) ||
			vaultFeeBps < 0 ||
			vaultFeeBps > 1000
		) {
			fail(`${where}: vault fee bps ${vaultFeeBps} is outside 0..1000`)
		}
		const expectedP = (a * 10_000n) / (10_000n + BigInt(vaultFeeBps))
		if (p !== expectedP) {
			fail(
				`${where}: PayerPays principal ${p} is not floor(A*10000/(10000+${vaultFeeBps}))=${expectedP}`,
			)
		}
		const expectedFee = (p * BigInt(vaultFeeBps)) / 10_000n
		if (fee !== expectedFee) {
			fail(
				`${where}: quoted fee ${fee} is not f(P)=${expectedFee} at deployed ${vaultFeeBps} bps`,
			)
		}
		return
	}

	for (let bps = 0; bps <= 1000; bps++) {
		if ((p * BigInt(bps)) / 10_000n !== fee) continue
		if ((a * 10_000n) / (10_000n + BigInt(bps)) === p) return
	}
	fail(
		`${where}: PayerPays P=${p}, fee=${fee}, A=${a} are not consistent with vault sizing P=floor(A*10000/(10000+bps)), f=floor(P*bps/10000)`,
	)
}

/**
 * CCR-13: the quote freezes every leg amount, fee mode and the PayerPays remainder; payment
 * creation must copy those values instead of re-pricing. The lock's principal/mode are checked
 * separately from the transaction (DF3 Stellar).
 */
export function expectFrozenAccounting(
	quote: QuoteView,
	payment: PaymentView,
	where = "CCR-13",
): void {
	const fees = quote.fees
	if (!fees) fail(`${where}: quote has no fee breakdown`)
	const plannedSettle = quote.route.find((leg) => leg.kind === "settle")
	if (!plannedSettle) {
		if (quote.feeMode !== null)
			fail(`${where}: quote has no settle but feeMode is ${quote.feeMode}`)
		if (fees.settleUnlockedRemainder !== null)
			fail(`${where}: quote has no settle but carries a settle remainder`)
	} else {
		if (!quote.feeMode) fail(`${where}: settle quote has no feeMode`)
		if (!plannedSettle.amountIn || !plannedSettle.amountOut)
			fail(`${where}: quoted settle leg has no frozen amounts`)
		const settle = payment.legs.find((leg) => leg.kind === "settle")
		if (!settle) fail(`${where}: payment has no settle leg`)
		expectMoneyEqual(
			settle.amountIn,
			plannedSettle.amountIn,
			`${where}: settle amountIn`,
		)
		expectMoneyEqual(
			settle.amountOut,
			plannedSettle.amountOut,
			`${where}: settle amountOut`,
		)

		const feeLeg = fees.legs.find((leg) => leg.kind === "settle")
		if (!feeLeg) fail(`${where}: fee breakdown has no settle fee`)
		expectMoneyEqual(feeLeg.fee, fees.flexiPayFee, `${where}: settle fee`)
		if (plannedSettle.amountIn.currency !== fees.flexiPayFee.currency) {
			fail(
				`${where}: settle principal is ${plannedSettle.amountIn.currency} but fee is ${fees.flexiPayFee.currency}`,
			)
		}

		const principal = minor(plannedSettle.amountIn, `${where}: principal`)
		const fee = minor(fees.flexiPayFee, `${where}: fee`)
		if (quote.feeMode === "PayerPays") {
			if (plannedSettle.amountIn.amount !== plannedSettle.amountOut.amount) {
				fail(`${where}: PayerPays settle principal and net must both be P`)
			}
		} else {
			const expectedNet = principal - fee
			if (expectedNet <= 0n)
				fail(`${where}: RecipientPays fee consumes the principal`)
			if (plannedSettle.amountOut.amount !== expectedNet.toString()) {
				fail(
					`${where}: RecipientPays settle net is ${plannedSettle.amountOut.amount}, expected ${expectedNet}`,
				)
			}
		}

		const settleIndex = quote.route.indexOf(plannedSettle)
		if (settleIndex > 0) {
			const available = quote.route[settleIndex - 1]?.amountOut
			if (!available) fail(`${where}: leg before settle has no amountOut`)
			if (available.currency !== plannedSettle.amountIn.currency) {
				fail(`${where}: pre-settle amount and principal use different assets`)
			}
			if (quote.feeMode === "PayerPays") {
				const remainder =
					minor(available, `${where}: available`) - principal - fee
				if (remainder < 0n) {
					fail(`${where}: principal and fee exceed the available settle amount`)
				}
				const expectedRemainder = remainder === 0n ? null : remainder.toString()
				const seenRemainder = fees.settleUnlockedRemainder
				if (expectedRemainder === null) {
					if (seenRemainder !== null) {
						fail(
							`${where}: expected a null settleUnlockedRemainder, got ${seenRemainder.amount}`,
						)
					}
				} else {
					if (!seenRemainder)
						fail(
							`${where}: missing settleUnlockedRemainder ${expectedRemainder}`,
						)
					if (seenRemainder.amount !== expectedRemainder) {
						fail(
							`${where}: settleUnlockedRemainder ${seenRemainder.amount}, expected ${expectedRemainder}`,
						)
					}
					if (seenRemainder.currency !== available.currency) {
						fail(
							`${where}: settleUnlockedRemainder currency does not match the settle asset`,
						)
					}
				}
			}
		}
	}

	// Every planned leg must appear with the same frozen amounts; a reversal/additional leg does
	// not remove the original execution row.
	for (const [index, planned] of quote.route.entries()) {
		const amountIn = planned.amountIn
		const amountOut = planned.amountOut
		if (!amountIn || !amountOut)
			fail(`${where}: quote.route[${index}] has no frozen amounts`)
		const match = payment.legs.find(
			(leg) =>
				leg.kind === planned.kind &&
				leg.rail === planned.rail &&
				leg.amountIn !== undefined &&
				leg.amountOut !== undefined &&
				sameMoney(leg.amountIn, amountIn) &&
				sameMoney(leg.amountOut, amountOut),
		)
		if (!match) {
			fail(
				`${where}: payment has no ${planned.kind} leg with the quoted ${amountIn.amount}→${amountOut.amount}`,
			)
		}
	}
}

/**
 * DF3: `Leg.releaseTxRef` is documented as a release **or refund** hash (CCR-12). A paid claim
 * must therefore be proven by the release event, not by the field name alone: the settle leg is
 * succeeded and exactly one `payment.onchain` event says `phase: "release"` for this payout and
 * hash. A refund event is never accepted as a successful claim release.
 */
export function expectClaimRelease(
	payment: PaymentView,
	events: readonly EventView[],
	releaseTxRef: string | undefined,
	payoutId: string,
): void {
	const settle = payment.legs.find((leg) => leg.kind === "settle")
	if (!settle) fail("accepted payment has no settle leg")
	if (settle.status !== "succeeded") {
		fail(`accepted settle leg is ${settle.status}, not succeeded`)
	}
	if (!releaseTxRef) fail("accepted settle leg has no releaseTxRef")
	if (settle.releaseTxRef !== releaseTxRef) {
		fail("accepted settle leg changed its releaseTxRef")
	}

	const onchain = events.filter((event) => event.type === "payment.onchain")
	const refunds = onchain.filter((event) => {
		const snapshot = record(event.snapshot, "payment.onchain.snapshot")
		return snapshot.phase === "refund"
	})
	if (refunds.length > 0) {
		fail(
			"claim release timeline contains a refund; a refund is not a claim release",
		)
	}
	const releases = onchain.filter((event) => {
		const snapshot = record(event.snapshot, "payment.onchain.snapshot")
		return snapshot.phase === "release"
	})
	if (releases.length !== 1) {
		fail(
			`claim release has ${releases.length} release events, expected exactly one`,
		)
	}
	const snapshot = record(releases[0]!.snapshot, "release.snapshot")
	if (snapshot.payoutId !== payoutId) {
		fail(
			`release event payout ${String(snapshot.payoutId)}, expected ${payoutId}`,
		)
	}
	if (snapshot.releaseTxRef !== releaseTxRef) {
		fail("release event hash does not match settle.releaseTxRef")
	}
}

/**
 * Format check only. A 64-hex string is not proof of a Stellar settlement: DF3 on Stellar must
 * also verify the hash against the testnet RPC (`lib/stellar-proof.ts`).
 */
export function expectTxRef(
	ref: string | undefined,
	network: "mock" | "stellar",
	where: string,
): void {
	if (ref === undefined) fail(`${where}: no transaction reference`)
	if (network === "stellar") {
		if (!/^[0-9a-f]{64}$/.test(ref)) {
			fail(
				`${where}: "${ref}" is not a 64-character lowercase hex Stellar transaction hash`,
			)
		}
		if (/^mock/i.test(ref)) fail(`${where}: mock reference recorded as Stellar`)
		return
	}
	if (!/^mock[-_]/i.test(ref))
		fail(`${where}: "${ref}" is not a labelled mock reference`)
}

/**
 * The quote must echo the mode used to price settle, and never invent one: a settle route
 * carries the requested FeeMode; a route without settle carries null (CCR-8).
 */
export function expectQuoteFeeMode(
	quote: QuoteView,
	expected: FeeMode,
	where = "quote",
): void {
	const settles = quote.route.some((leg) => leg.kind === "settle")
	if (settles && quote.feeMode !== expected) {
		fail(
			`${where}: feeMode is ${quote.feeMode ?? "missing"}, expected the requested ${expected}`,
		)
	}
	if (!settles && quote.feeMode !== null) {
		fail(
			`${where}: feeMode is ${quote.feeMode} on a route without settle, expected null`,
		)
	}
}

export function expectReasons(
	reasons: readonly string[],
	patterns: readonly RegExp[],
	where: string,
): void {
	const joined = reasons.join(" | ")
	if (reasons.length === 0) fail(`${where}: reasons are empty`)
	for (const pattern of patterns) {
		if (!pattern.test(joined))
			fail(`${where}: no reason matches ${pattern}; got "${joined}"`)
	}
}

export function expectEventTypes(
	types: readonly string[],
	required: readonly string[],
	where = "timeline",
): void {
	for (const type of required) {
		if (!types.includes(type))
			fail(
				`${where}: missing event ${type}; saw ${types.join(", ") || "(none)"}`,
			)
	}
}

export function expectNoEvent(
	types: readonly string[],
	forbidden: string,
	where = "timeline",
): void {
	if (types.includes(forbidden)) fail(`${where}: unexpected ${forbidden}`)
}

export function expectSimulated(value: boolean, where: string): void {
	if (!value) fail(`${where}: simulated flag must be true for a simulated item`)
}

export function expectFutureWindow(
	iso: string,
	maxSeconds: number,
	where: string,
): void {
	const at = Date.parse(iso)
	if (!Number.isFinite(at)) fail(`${where}: "${iso}" is not a timestamp`)
	const seconds = (at - Date.now()) / 1000
	if (seconds <= 0) fail(`${where}: already expired`)
	if (seconds > maxSeconds) {
		fail(
			`${where}: expires in ${Math.round(seconds)} s, expected at most ${maxSeconds} s`,
		)
	}
}
