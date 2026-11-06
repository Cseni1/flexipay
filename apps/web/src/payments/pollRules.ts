import { type PaymentDetail } from "@flexipay/web-lib/contract"

const MOVING_STATUSES = new Set(["funded", "processing", "refunding"])

/** Poll while the payment is moving: funded, processing (also between legs) or refunding. */
export const shouldPollPayment = (
	payment: Pick<PaymentDetail, "status">,
): boolean => MOVING_STATUSES.has(payment.status)

/** A leg is waiting on a partner: show "Waiting for …" and slow down to every 10 s. */
export const isWaitingOnLeg = (
	payment: Pick<PaymentDetail, "status" | "legs">,
): boolean =>
	payment.status === "processing" &&
	payment.legs.some((leg) => leg.status === "processing")
