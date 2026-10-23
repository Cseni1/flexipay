import type { LegKind, PaymentStatus } from "@flexipay/domain"
import { fail } from "./parse.ts"
import type { LegView, PaymentView } from "./types.ts"

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

export function expectAttempts(
	legs: readonly LegView[],
	kind: LegKind,
	count: number,
	where: string,
): void {
	const attempts = legs.filter((l) => l.kind === kind).length
	if (attempts !== count)
		fail(`${where}: ${attempts} ${kind} attempt(s), expected exactly ${count}`)
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
