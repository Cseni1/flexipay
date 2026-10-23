/**
 * D1 contract questions closed against A0 (`packages/domain/src/api`) + Architecture v5.
 * No new API fields were invented; demos use quotes, legs, events and settle.externalRef.
 *
 * 1. Batch route/reasons — A0 has no batches schema. Reasons live on `QuoteSchema.reasons`.
 *    Payment carries `quoteId` but PaymentDetail does not embed the quote. DF1 proves the
 *    domestic rail from payment legs and captures reasons via a parallel US quote.
 *
 * 2. Payout attempts / leg.failed — `LegSchema` has no `attempt`. Retry proof uses
 *    `Event.snapshot` (published Payment legs): exactly two `leg.failed` events, each carrying
 *    the failed payout leg on the routed provider with a distinct `externalRef`, then
 *    `payment.refunded` and no third failure. A snapshot without legs/ref is BLOCKED, not PASS.
 *
 * 3. Vault refund / settle status — Identify refund by `PaymentStatus=refunded` and
 *    `payment.refunded`. Collect/convert must be `reversed` (§7 / SCENARIOS). Settle status
 *    after SettlementAdapter.refund is not a separate A0 field; do not require settle.reversed.
 *
 * 4. Lock vs release refs — One `Leg.externalRef` on settle. Capture before accept (lock) and
 *    after (release). Release is verified on Stellar RPC; if refs coincide, release RPC proof
 *    still stands (ARCHITECTURE: release is the visible tx).
 *
 * 5. DF5 recipient-kind exclusion — No refusal-code enum in A0. The eligible quote's
 *    `reasons[]` and the 422 refusal both must name crypto and the company recipient kind.
 *    Exact prose remains free; a non-empty generic reason is not acceptance.
 */

export const A0_CONTRACT_ANSWERS = {
	batchReasons:
		"Quote.reasons only; no batch-row reasons in A0. DF1 uses a parallel US quote for explanation.",
	payoutAttempts:
		"No Leg.attempt; two leg.failed snapshots must show distinct failed payout externalRefs, then payment.refunded and no third failure.",
	vaultRefund:
		"payment.refunded + status refunded; collect/convert reversed; settle status not asserted.",
	lockRelease:
		"Single settle.externalRef; compare pre/post accept; lock create_payout external id and release claim of the same payout/recipient are verified via RPC.",
	df5Refusal:
		"No stable reason code; non-empty reasons[] on quote and 422 refusal.",
} as const
