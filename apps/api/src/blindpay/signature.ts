import { createHmac, timingSafeEqual } from "node:crypto";

const TOLERANCE_SECONDS = 5 * 60;

/**
 * BlindPay signs webhooks with Svix: HMAC-SHA256 over `id.timestamp.rawBody`,
 * key = base64(secret after `whsec_`). Rejects a stale timestamp.
 */
export function verifyBlindpaySignature(input: {
	secret: string;
	svixId: string;
	svixTimestamp: string;
	svixSignature: string;
	rawBody: Buffer;
	nowMs?: number;
}): boolean {
	const secretPart = input.secret.startsWith("whsec_")
		? input.secret.slice("whsec_".length)
		: input.secret;
	let key: Buffer;
	try {
		key = Buffer.from(secretPart, "base64");
	} catch {
		return false;
	}
	if (key.length === 0) return false;
	const stamped = Number(input.svixTimestamp);
	if (!Number.isFinite(stamped)) return false;
	const now = Math.floor((input.nowMs ?? Date.now()) / 1000);
	if (Math.abs(now - stamped) > TOLERANCE_SECONDS) return false;
	const signed = `${input.svixId}.${input.svixTimestamp}.${input.rawBody.toString("utf8")}`;
	const expected = createHmac("sha256", key).update(signed).digest();
	const candidates = input.svixSignature
		.split(" ")
		.map((part) => part.split(",")[1] ?? "")
		.filter((part) => part.length > 0);
	return candidates.some((candidate) => {
		let given: Buffer;
		try {
			given = Buffer.from(candidate, "base64");
		} catch {
			return false;
		}
		if (given.length !== expected.length) return false;
		return timingSafeEqual(given, expected);
	});
}
