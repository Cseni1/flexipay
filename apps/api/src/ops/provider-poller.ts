import type { Db } from "../db.ts"
import { fundAndRun } from "../orchestrator/index.ts"
import type { OrchestratorAdapters } from "../orchestrator/types.ts"

// CCR-29: partner legs (BlindPay, Tazapay) can stay `processing` for minutes or days. The leg
// runner stops at such a leg; this poller resumes each payment that has one, which re-reads the
// partner's status and carries on to the next leg when it has succeeded.

const NON_SETTLE_KINDS = ["collect", "convert", "payout"]

/** Payment ids with a non-settle leg waiting on a partner, or with every leg done but not paid. */
export async function paymentsWaitingOnProviders(db: Db): Promise<string[]> {
	const rows = await db.leg.findMany({
		where: {
			status: "processing",
			kind: { in: NON_SETTLE_KINDS },
			externalRef: { not: null },
			payment: { status: "processing" },
		},
		select: { paymentId: true },
		distinct: ["paymentId"],
		take: 50,
	})
	// CCR-33: every leg succeeded but the payment was never marked paid (for example the final
	// step failed once); without this the payment would never be picked up again.
	const finished = await db.payment.findMany({
		where: {
			status: "processing",
			legs: { some: {}, every: { status: "succeeded" } },
		},
		select: { id: true },
		take: 50,
	})
	// CCR-37: a Solana refund that failed, restarted or is awaiting confirmation stays in
	// `refunding`; the poller retries it through the same durable signed transaction.
	const refunding = await db.payment.findMany({
		where: { status: "refunding" },
		select: { id: true },
		take: 50,
	})
	return [
		...new Set([
			...rows.map((r) => r.paymentId),
			...finished.map((p) => p.id),
			...refunding.map((p) => p.id),
		]),
	]
}

/** One pass: resumes every waiting payment; a failure on one never stops the others. */
export async function pollProvidersOnce(
	db: Db,
	adapters: OrchestratorAdapters,
	log: (msg: string) => void = console.error,
): Promise<number> {
	const ids = await paymentsWaitingOnProviders(db)
	for (const id of ids) {
		try {
			await fundAndRun(db, id, adapters)
		} catch (e) {
			log(
				`provider poller: payment ${id}: ${e instanceof Error ? e.message : "failed"}`,
			)
		}
	}
	return ids.length
}

/** Starts the poller; returns a stop function. Overlapping passes are skipped. */
export function startProviderPoller(
	db: Db,
	adapters: OrchestratorAdapters,
	intervalMs = 15_000,
): () => void {
	let running = false
	const timer = setInterval(() => {
		if (running) return
		running = true
		pollProvidersOnce(db, adapters)
			.catch((e) =>
				console.error(
					`provider poller: ${e instanceof Error ? e.message : "failed"}`,
				),
			)
			.finally(() => {
				running = false
			})
	}, intervalMs)
	timer.unref?.()
	return () => clearInterval(timer)
}
