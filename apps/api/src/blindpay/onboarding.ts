import { randomUUID } from "node:crypto";
import { BlindPayAdapter } from "@flexipay/adapters-live";
import {
	SENDER_WALLET_BLINDPAY_RAIL,
	type BlindPayKycBody,
	type BlindPayKycStep,
} from "@flexipay/domain";
import type { Db } from "../db.ts";
import { ApiError } from "../errors.ts";
import type { Ctx } from "../routes.ts";

type OrgKyc = {
	id: string;
	kind: string;
	blindpayCustomerId: string | null;
	blindpayKycStatus: string | null;
	blindpayTosId: string | null;
};

export function blindPayAdapter(ctx: Ctx): BlindPayAdapter {
	if (!ctx.runtime) {
		throw new ApiError(500, "internal_error", "runtime not configured");
	}
	for (const row of ctx.config.providers) {
		if (row.implementation !== "blindpay") continue;
		const found = ctx.runtime.getProvider(row.id);
		if (found instanceof BlindPayAdapter) return found;
	}
	throw new ApiError(
		503,
		"blindpay_unavailable",
		"BlindPay is not configured on this server",
	);
}

/**
 * CCR-46: where BlindPay's terms page sends the sender back, with `?tos_id=`. Always our own
 * web origin: a caller-supplied address is used only when it is on that origin (no open
 * redirect, and no tos id handed to another site).
 */
export function termsReturnUrl(
	candidate?: string,
	env: Record<string, string | undefined> = process.env,
): string | undefined {
	const origins = [env.WEB_ORIGIN, ...(env.WEB_ORIGIN_EXTRA ?? "").split(",")]
		.map((o) => o?.trim().replace(/\/$/, ""))
		.filter((o): o is string => !!o);
	if (origins.length === 0) return undefined;
	if (candidate) {
		try {
			const url = new URL(candidate);
			if (origins.includes(url.origin)) return url.toString();
		} catch {
			// fall through to the default
		}
	}
	return `${origins[0]}/blindpay/terms-done`;
}

const KYC_FILE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/heic",
	"image/heif",
	"application/pdf",
]);
export const KYC_FILE_MAX_BYTES = 5 * 1024 * 1024;

/** CCR-46: streams one identity document or selfie to BlindPay; FlexiPay stores nothing. */
export async function uploadSenderDocument(
	ctx: Ctx,
	orgId: string,
	file: { bytes: Uint8Array; contentType: string },
): Promise<{ fileUrl: string }> {
	const org = await loadOrg(ctx.db, orgId);
	assertIndividualSender(org);
	if (typeof file.contentType !== "string") {
		throw new ApiError(415, "unsupported_file_type", "Upload a JPEG, PNG, WEBP, HEIC or PDF file");
	}
	const contentType = file.contentType.split(";")[0]!.trim().toLowerCase();
	if (!KYC_FILE_TYPES.has(contentType)) {
		throw new ApiError(
			415,
			"unsupported_file_type",
			"Upload a JPEG, PNG, WEBP, HEIC or PDF file",
		);
	}
	if (file.bytes.length === 0 || file.bytes.length > KYC_FILE_MAX_BYTES) {
		throw new ApiError(413, "file_too_large", "Files must be between 1 byte and 5 MB");
	}
	const ext = contentType === "application/pdf" ? "pdf" : contentType.split("/")[1];
	try {
		return await blindPayAdapter(ctx).uploadKycFile({
			bytes: file.bytes,
			contentType,
			name: `kyc-${Date.now()}.${ext}`,
		});
	} catch (cause) {
		if (cause instanceof ApiError) throw cause;
		throw new ApiError(
			502,
			"upload_failed",
			"BlindPay could not store the file. Try again, or use a clearer photo.",
		);
	}
}

export function assertIndividualSender(org: { kind: string }): void {
	if (org.kind !== "individual") {
		throw new ApiError(
			422,
			"not_eligible",
			"sender_wallet_blindpay is only for an individual sender",
		);
	}
}

async function loadOrg(db: Db, orgId: string): Promise<OrgKyc> {
	return db.organization.findUniqueOrThrow({
		where: { id: orgId },
		select: {
			id: true,
			kind: true,
			blindpayCustomerId: true,
			blindpayKycStatus: true,
			blindpayTosId: true,
		},
	});
}

/**
 * Starts or resumes BlindPay KYC. The hosted terms URL is the self-serve first step.
 * Identity fields are only sent later, from the sender, never invented here.
 */
export async function senderWalletOnboarding(
	ctx: Ctx,
	orgId: string,
	redirectUrl?: string,
): Promise<{
	receiverId: string | null;
	kycStatus: string | null;
	next: BlindPayKycStep;
}> {
	const org = await loadOrg(ctx.db, orgId);
	assertIndividualSender(org);
	const next = await nextKycStep(ctx, org, redirectUrl);
	const fresh = await loadOrg(ctx.db, orgId);
	return {
		receiverId: fresh.blindpayCustomerId,
		kycStatus: fresh.blindpayKycStatus,
		next,
	};
}

export async function rememberTos(
	ctx: Ctx,
	orgId: string,
	tosId: string,
): Promise<{
	receiverId: string | null;
	kycStatus: string | null;
	next: BlindPayKycStep;
}> {
	const org = await loadOrg(ctx.db, orgId);
	assertIndividualSender(org);
	await ctx.db.organization.update({
		where: { id: orgId },
		data: { blindpayTosId: tosId },
	});
	return senderWalletOnboarding(ctx, orgId);
}

export async function submitSenderKyc(
	ctx: Ctx,
	orgId: string,
	body: BlindPayKycBody,
): Promise<{
	receiverId: string | null;
	kycStatus: string | null;
	next: BlindPayKycStep;
}> {
	const org = await loadOrg(ctx.db, orgId);
	assertIndividualSender(org);
	if (!org.blindpayTosId) {
		const next = await nextKycStep(ctx, org);
		throw new ApiError(
			422,
			"kyc_required",
			"Accept BlindPay's terms before submitting identity details",
			next,
		);
	}
	if (org.blindpayCustomerId && org.blindpayKycStatus !== "rejected") {
		const next = await nextKycStep(ctx, org);
		return {
			receiverId: org.blindpayCustomerId,
			kycStatus: org.blindpayKycStatus,
			next,
		};
	}
	const adapter = blindPayAdapter(ctx);
	const payload = Object.fromEntries(
		Object.entries(body).filter(([, value]) => value !== undefined),
	);
	const created = await adapter.createIndividualCustomer(org.blindpayTosId, payload);
	await ctx.db.organization.update({
		where: { id: orgId },
		data: {
			blindpayCustomerId: created.id,
			blindpayKycStatus: created.kycStatus,
		},
	});
	const stored = await loadOrg(ctx.db, orgId);
	const next = await nextKycStep(ctx, stored);
	return {
		receiverId: created.id,
		kycStatus: created.kycStatus,
		next,
	};
}

/** Refuses a sender-wallet quote until BlindPay reports the customer approved. */
export async function assertSenderKycApproved(ctx: Ctx, orgId: string): Promise<void> {
	const org = await loadOrg(ctx.db, orgId);
	assertIndividualSender(org);
	const next = await nextKycStep(ctx, org);
	if (next.step === "approved") return;
	throw new ApiError(
		422,
		"kyc_required",
		"Complete BlindPay identity verification before quoting a sender-wallet payout",
		next,
	);
}

async function nextKycStep(
	ctx: Ctx,
	org: OrgKyc,
	redirectUrl?: string,
): Promise<BlindPayKycStep> {
	const adapter = blindPayAdapter(ctx);
	if (!org.blindpayTosId) {
		const terms = await adapter.startTermsOfService(
			randomUUID(),
			termsReturnUrl(redirectUrl),
		);
		return { step: "accept_terms", url: terms.url };
	}
	if (!org.blindpayCustomerId) return { step: "submit_kyc" };
	let status = org.blindpayKycStatus ?? "verifying";
	if (status !== "approved") {
		status = await adapter.customerKycStatus(org.blindpayCustomerId);
		if (status !== org.blindpayKycStatus) {
			await ctx.db.organization.update({
				where: { id: org.id },
				data: { blindpayKycStatus: status },
			});
		}
	}
	if (status === "approved") {
		return { step: "approved", receiverId: org.blindpayCustomerId };
	}
	return { step: "wait_for_review", kycStatus: status };
}

export function isSenderWalletQuote(route: unknown): boolean {
	return (
		Array.isArray(route) &&
		route.some(
			(leg) =>
				leg &&
				typeof leg === "object" &&
				"rail" in leg &&
				(leg as { rail?: string }).rail === SENDER_WALLET_BLINDPAY_RAIL,
		)
	);
}
