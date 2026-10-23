import { BlockedError } from "./report.ts"
import type { BatchView, PaymentView } from "./types.ts"

// Seams for evidence the shared contract has not defined. They throw BLOCKED with the exact A0
// question rather than inventing a field, a count or a wording. Wire each one only when the A0
// schema names the evidence.

/** DF1: a batch row's chosen route and quote reasons. */
export function requireBatchRouteReasons(batch: BatchView): never {
	throw new BlockedError([
		{
			what: "A0 does not define where a batch row exposes its chosen route and quote reasons",
			owner: "Csaba (A0 / CC2)",
			detail:
				`DF1 has the US legs of batch ${batch.id}, but the domestic choice must also be explained. ` +
				"Name the field on GET /v1/batches/{id} (or the row) that carries the quote route and reasons; " +
				"SCENARIOS.md leaves the batch row shape TBD.",
		},
	])
}

/**
 * DF4: attempt history and vault-refund evidence. The terminal state is asserted first; this seam
 * then blocks because neither document fixes how the retry count or the refund is represented.
 */
export function requireRetryAndRefundEvidence(payment: PaymentView): never {
	throw new BlockedError([
		{
			what: "A0 does not define how payout attempts are exposed",
			owner: "Csaba (A0 / CC2)",
			detail:
				`Payment ${payment.id} is refunded, but proving exactly one retry needs the attempt history. ` +
				"SCENARIOS.md marks it TBD: repeated payout legs, an attempts array, or attempts on one leg? " +
				"Also state whether one leg.failed event fires per attempt or per leg.",
		},
		{
			what: "A0 does not define the vault-refund evidence or the settle leg's status after refund",
			owner: "Csaba (A0 / CC2)",
			detail:
				"ARCHITECTURE §7 says refund through the settlement adapter and reverse earlier legs; " +
				"SCENARIOS.md names only the collect leg. Does the settle leg become reversed, stay succeeded, " +
				"or is there a separate refund reference? DF4 will not assume either.",
		},
	])
}
