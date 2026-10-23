import type { BatchView, DemoApi, PaymentView } from "./types.ts"

// Bounded polling for the synchronous orchestrator: a few short reads, never an unbounded loop
// and never a replay of a mutation.

const TERMINAL_PAYMENT = new Set([
	"paid",
	"refunded",
	"failed",
	"cancelled",
	"expired",
])
const TERMINAL_BATCH = new Set([
	"paid",
	"completed",
	"failed",
	"refunded",
	"cancelled",
])

export async function waitForPayment(
	api: DemoApi,
	paymentId: string,
	done: (payment: PaymentView) => boolean = (p) =>
		TERMINAL_PAYMENT.has(p.status),
	attempts = 8,
	delayMs = 250,
): Promise<PaymentView> {
	let payment = await api.payment(paymentId)
	for (let i = 1; i < attempts && !done(payment); i++) {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		payment = await api.payment(paymentId)
	}
	return payment
}

export async function waitForBatch(
	api: DemoApi,
	batchId: string,
	attempts = 8,
	delayMs = 250,
): Promise<BatchView> {
	let batch = await api.batch(batchId)
	for (
		let i = 1;
		i < attempts && !TERMINAL_BATCH.has(batch.status.toLowerCase());
		i++
	) {
		await new Promise((resolve) => setTimeout(resolve, delayMs))
		batch = await api.batch(batchId)
	}
	return batch
}
