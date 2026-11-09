import { type Leg, type PaymentStatus } from "@flexipay/web-lib/contract"

export type ProgressStepState = "done" | "current" | "todo" | "stopped"

export type ProgressStep = {
	key: "pay" | "convert" | "move" | "deliver" | "end"
	label: string
	state: ProgressStepState
}

type ProgressInput = {
	status: PaymentStatus
	legs: readonly Pick<Leg, "kind" | "status">[]
	/** True when the event log has a payment.funded milestone. */
	funded?: boolean
	/** The sender still has to pay from a wallet (Solana or BlindPay panel shown). */
	senderActionNeeded?: boolean
}

const WAITING_FOR_SENDER: readonly PaymentStatus[] = [
	"quoted",
	"awaiting_funding",
]

const STOPPED_LABELS: Partial<Record<PaymentStatus, string>> = {
	failed: "Payment stopped",
	refunding: "Returning your money",
	refunded: "Money returned to you",
	cancelled: "Cancelled",
	expired: "Expired",
}

/** True while the payment needs the sender to pay before anything moves. */
export const isWaitingForSender = (status: PaymentStatus): boolean =>
	WAITING_FOR_SENDER.includes(status)

/**
 * Plain-words progress for the payment summary. Derived only from the payment
 * status and its legs: "You paid" → "Changing currency" (when the route converts)
 * → "On its way" → "Delivered". A failed, returned, cancelled or expired payment
 * keeps the steps it finished and ends on one clear stopped step.
 */
export function paymentProgress({
	status,
	legs,
	funded = false,
	senderActionNeeded = false,
}: ProgressInput): ProgressStep[] {
	const ofKind = (kind: Leg["kind"]) => legs.filter((leg) => leg.kind === kind)
	const allSucceeded = (kind: Leg["kind"]) => {
		const list = ofKind(kind)
		return list.length > 0 && list.every((leg) => leg.status === "succeeded")
	}
	const converts = ofKind("convert").length > 0
	const delivered = status === "paid"
	const paidIn =
		delivered ||
		(!senderActionNeeded &&
			(funded ||
				status === "funded" ||
				status === "processing" ||
				allSucceeded("collect") ||
				legs.some(
					(leg) =>
						leg.kind !== "collect" &&
						(leg.status === "processing" || leg.status === "succeeded"),
				)))
	const converted = delivered || allSucceeded("convert")

	const plan: { key: ProgressStep["key"]; label: string; done: boolean }[] = [
		{ key: "pay", label: paidIn ? "We got your money" : "You pay", done: paidIn },
	]
	if (converts) {
		plan.push({ key: "convert", label: "Converting", done: converted })
	}
	plan.push({ key: "move", label: "Sent to their account", done: delivered })
	plan.push({ key: "deliver", label: "Delivered", done: delivered })

	const stoppedLabel = STOPPED_LABELS[status]
	if (stoppedLabel) {
		const finished: ProgressStep[] = plan
			.filter((step) => step.done && step.key !== "deliver")
			.map((step) => ({ key: step.key, label: step.label, state: "done" }))
		return [...finished, { key: "end", label: stoppedLabel, state: "stopped" }]
	}

	let currentSeen = false
	return plan.map((step) => {
		if (step.done) return { key: step.key, label: step.label, state: "done" }
		if (!currentSeen) {
			currentSeen = true
			return { key: step.key, label: step.label, state: "current" }
		}
		return { key: step.key, label: step.label, state: "todo" }
	})
}

/** One short sentence for the summary card, in plain words. */
export function paymentHeadline(
	status: PaymentStatus,
	recipientName: string,
): string {
	switch (status) {
		case "quoted":
		case "awaiting_funding":
			return "Waiting for you to pay. Nothing has left your account yet."
		case "funded":
			return "We have your money and are sending it now."
		case "processing":
			return `Your money is on its way to ${recipientName}.`
		case "paid":
			return `Delivered to ${recipientName}.`
		case "failed":
			return "This payment did not go through."
		case "refunding":
			return "We are sending your money back to you."
		case "refunded":
			return "Your money was returned to you."
		case "cancelled":
			return "This payment was cancelled."
		case "expired":
			return "This payment expired before it was paid."
	}
}

/** Up to two initials for an avatar, from a display name. */
export function initialsOf(name: string): string {
	const words = name
		.replace(/[^\p{L}\s]/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean)
	if (words.length === 0) return "?"
	const first = words[0]?.[0] ?? ""
	const second = words.length > 1 ? (words.at(-1)?.[0] ?? "") : ""
	return (first + second).toUpperCase()
}
