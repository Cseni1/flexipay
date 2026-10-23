/**
 * D1 contract questions closed against A0 (`packages/domain/src/api`) + Architecture v5.
 * No new API fields were invented; demos use quotes, legs, events and settle.externalRef.
 *
 * 1. Batch route/reasons — A0 has no batches schema. Reasons live on `QuoteSchema.reasons`.
 *    Payment carries `quoteId` but PaymentDetail does not embed the quote. DF1 proves the
 *    domestic rail from payment legs and captures reasons via a parallel US quote.
 *
 * 2. Payout attempts / leg.failed — CCR-14 publishes `Leg.attempt`; attempt 1 is the first try,
 *    attempt 2 the only retry, and attempt 3 is forbidden. Retry proof uses `Event.snapshot`
 *    (published Payment legs): two `leg.failed` events show attempts 1 and 2, then one
 *    `payment.refunded`, with no attempt 3. The retry may clear provider refs, so equal or
 *    missing `externalRef` values are not evidence against a retry.
 *
 * 3. Vault refund / settle status — Identify refund by `PaymentStatus=refunded` and
 *    `payment.refunded`. Collect/convert must be `reversed` (§7 / SCENARIOS). Settle status
 *    after SettlementAdapter.refund is not a separate A0 field; do not require settle.reversed.
 *
 * 4. Lock vs release refs — CCR-12 separates them. On a settle leg, `externalRef` is the vault
 *    `payoutId` (positive decimal), `lockTxRef` is the lock transaction and `releaseTxRef` is
 *    the release or refund transaction. DF3 compares the payoutId before and after acceptance
 *    and verifies both hashes privately through the RPC: the lock's `create_payout` external id
 *    ties it to the payment, and the release's `claim` payout id, secret hash and destination tie
 *    it to that lock and the intended recipient. A 64-hex `externalRef` is a contract defect.
 *
 * 5. DF5 recipient-kind exclusion — No refusal-code enum in A0. The eligible quote's
 *    `reasons[]` and the 422 refusal must together carry the meaning: crypto, the company
 *    recipient kind, and an exclusion. The facts may be spread over several reasons; no exact
 *    sentence or single item is required, and non-empty generic prose is not acceptance.
 *
 * 6. CCR-11 restart acceptance — claim secrets are sealed at rest with `FP_CLAIM_SEAL_KEY`.
 *    Acceptance restarts the API against the same database and key and never asks the API to
 *    reveal a secret; the release transaction's calldata is inspected privately instead.
 *    Procedure and blocker: `scripts/demo/evidence/2026-10-23-d3-acceptance.md`.
 */

export const A0_CONTRACT_ANSWERS = {
	batchReasons:
		"Quote.reasons only; no batch-row reasons in A0. DF1 uses a parallel US quote for explanation.",
	payoutAttempts:
		"Leg.attempt is durable (CCR-14); two leg.failed snapshots must show attempts 1 and 2, then payment.refunded, no attempt 3; refs may be cleared or repeated.",
	vaultRefund:
		"payment.refunded + status refunded; collect/convert reversed; settle status not asserted.",
	lockRelease:
		"CCR-12: settle.externalRef is the payoutId; lockTxRef and releaseTxRef are distinct, successful transactions verified via RPC (create_payout external id; claim payout id, secret hash and recipient).",
	df5Refusal:
		"No stable reason code; the quote reasons[] and 422 refusal must together name crypto, the company kind and an exclusion, spread over items if needed.",
	restart:
		"CCR-11: same database and FP_CLAIM_SEAL_KEY across restart; no secret via the API; release calldata inspected privately.",
} as const
