import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

/**
 * Tazapay signs webhooks with HMAC-SHA256 over `eventId + rawBody + createdAt`,
 * Base64 encoded in the `signature` header. Reject a stale timestamp.
 */
export function verifyTazapaySignature(input: {
	secret: string;
	signature: string;
	rawBody: Buffer;
	eventId: string;
	createdAt: string;
	nowMs?: number;
}): boolean {
	const secret = input.secret.trim();
	const signature = input.signature.trim();
	if (!secret || !signature || !input.eventId || !input.createdAt) return false;
	const stamped = Date.parse(input.createdAt);
	if (!Number.isFinite(stamped)) return false;
	const now = input.nowMs ?? Date.now();
	if (Math.abs(now - stamped) > TOLERANCE_SECONDS * 1000) return false;
	const signed = `${input.eventId}${input.rawBody.toString("utf8")}${input.createdAt}`;
	const expected = createHmac("sha256", secret).update(signed).digest();
	let given: Buffer;
	try {
		given = Buffer.from(signature, "base64");
	} catch {
		return false;
	}
	if (given.length !== expected.length) return false;
	return timingSafeEqual(given, expected);
}
