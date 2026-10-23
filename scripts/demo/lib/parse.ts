import {
	LEG_KINDS,
	LEG_STATUSES,
	PAYMENT_STATUSES,
	type LegKind,
	type LegStatus,
	type PaymentStatus,
} from "@flexipay/domain"
import type {
	EventView,
	LegView,
	MoneyView,
	PaymentView,
	QuoteView,
} from "./types.ts"

// Parsers for the semantic view. They check the documented fields and fail with the path they
// were reading, so a broken response names the field rather than only the flow.

export class AssertionFailure extends Error {
	constructor(message: string) {
		super(message)
		this.name = "AssertionFailure"
	}
}

export function fail(message: string): never {
	throw new AssertionFailure(message)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

export function record(value: unknown, where: string): Record<string, unknown> {
	if (!isRecord(value)) fail(`${where}: expected an object`)
	return value
}

export function list(value: unknown, where: string): unknown[] {
	if (!Array.isArray(value)) fail(`${where}: expected an array`)
	return value
}

export function text(value: unknown, where: string): string {
	if (typeof value !== "string" || value.length === 0)
		fail(`${where}: expected a non-empty string`)
	return value
}

export function integerString(value: unknown, where: string): string {
	const raw = text(value, where)
	if (!/^(0|[1-9][0-9]*)$/.test(raw))
		fail(`${where}: expected integer minor units, got "${raw}"`)
	return raw
}

export function money(value: unknown, where: string): MoneyView {
	const m = record(value, where)
	return {
		amount: integerString(m.amount, `${where}.amount`),
		currency: text(m.currency, `${where}.currency`),
	}
}

const oneOf = <T extends string>(
	value: unknown,
	allowed: readonly T[],
	where: string,
): T => {
	const raw = text(value, where)
	if (!(allowed as readonly string[]).includes(raw)) {
		fail(`${where}: "${raw}" is not one of ${allowed.join(", ")}`)
	}
	return raw as T
}

export function leg(value: unknown, where: string): LegView {
	const l = record(value, where)
	const error =
		l.error === undefined ? undefined : record(l.error, `${where}.error`)
	const out: LegView = {
		kind: oneOf<LegKind>(l.kind, LEG_KINDS, `${where}.kind`),
		rail: text(l.rail, `${where}.rail`),
		status: oneOf<LegStatus>(l.status, LEG_STATUSES, `${where}.status`),
	}
	if (l.externalRef !== undefined)
		out.externalRef = text(l.externalRef, `${where}.externalRef`)
	if (l.attempt !== undefined) {
		const attempt =
			typeof l.attempt === "number"
				? l.attempt
				: Number(integerString(l.attempt, `${where}.attempt`))
		if (!Number.isInteger(attempt) || attempt < 1)
			fail(`${where}.attempt: expected a positive integer`)
		out.attempt = attempt
	}
	if (l.simulated !== undefined) out.simulated = l.simulated === true
	if (error) {
		out.error = {
			code:
				error.code === undefined
					? undefined
					: text(error.code, `${where}.error.code`),
			message:
				error.message === undefined
					? undefined
					: text(error.message, `${where}.error.message`),
		}
	}
	return out
}

export function events(value: unknown, where: string): EventView[] {
	return list(value, where).map((e, i) => {
		const event = record(e, `${where}[${i}]`)
		return { type: text(event.type, `${where}[${i}].type`) }
	})
}

export function payment(value: unknown, where = "payment"): PaymentView {
	const p = record(value, where)
	const out: PaymentView = {
		id: text(p.id, `${where}.id`),
		status: oneOf<PaymentStatus>(p.status, PAYMENT_STATUSES, `${where}.status`),
		legs: list(p.legs, `${where}.legs`).map((l, i) =>
			leg(l, `${where}.legs[${i}]`),
		),
	}
	if (p.delivery !== undefined)
		out.delivery = text(p.delivery, `${where}.delivery`)
	if (p.externalId !== undefined)
		out.externalId = text(p.externalId, `${where}.externalId`)
	if (p.quoteId !== undefined) out.quoteId = text(p.quoteId, `${where}.quoteId`)
	if (p.batchId !== undefined) out.batchId = text(p.batchId, `${where}.batchId`)
	if (p.simulated !== undefined) out.simulated = p.simulated === true
	if (p.network !== undefined) {
		out.network = oneOf(
			p.network,
			["mock", "stellar"] as const,
			`${where}.network`,
		)
	}
	if (p.events !== undefined) out.events = events(p.events, `${where}.events`)
	return out
}

export function quote(value: unknown, where = "quote"): QuoteView {
	const q = record(value, where)
	const out: QuoteView = {
		id: text(q.id, `${where}.id`),
		route: list(q.route, `${where}.route`).map((r, i) => {
			const legRow = record(r, `${where}.route[${i}]`)
			return {
				kind: oneOf<LegKind>(
					legRow.kind,
					LEG_KINDS,
					`${where}.route[${i}].kind`,
				),
				...(legRow.rail === undefined
					? {}
					: { rail: text(legRow.rail, `${where}.route[${i}].rail`) }),
			}
		}),
		reasons: list(q.reasons, `${where}.reasons`).map((r, i) =>
			text(r, `${where}.reasons[${i}]`),
		),
		expectedReceive: money(q.expectedReceive, `${where}.expectedReceive`),
		validUntil: text(q.validUntil, `${where}.validUntil`),
		simulated: q.simulated === true,
	}
	if (q.fxRate !== undefined) out.fxRate = text(q.fxRate, `${where}.fxRate`)
	if (q.fees !== undefined) out.fees = q.fees
	if (q.alternatives !== undefined)
		out.alternatives = list(q.alternatives, `${where}.alternatives`)
	return out
}
