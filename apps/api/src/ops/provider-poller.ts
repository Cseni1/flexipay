import type { Db } from "../db.ts"
import { fundAndRun } from "../orchestrator/index.ts"
import type { OrchestratorAdapters } from "../orchestrator/types.ts"

// CCR-29: partner legs (BlindPay, Tazapay) can stay `processing` for minutes or days. The leg
// runner stops at such a leg; this poller resumes each payment that has one, which re-reads the
// partner's status and carries on to the next leg when it has succeeded.

const NON_SETTLE_KINDS = ["collect", "convert", "payout"]

/** Payment ids with a non-settle leg waiting on a partner. */
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
	return rows.map((r) => r.paymentId)
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
