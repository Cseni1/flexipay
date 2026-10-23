import { z } from "zod";
import { IsoTimestamp, RailId } from "./common.ts";

// POST /v1/sandbox/* (ARCHITECTURE §10, CCR-4 SandboxControls). Demo-only controls.
// Only request fields named in those sources / accepted CCRs are contracted here.
// Sandbox routes still omit success schemas except CCR-6 advance-time.

/**
 * fail-next (ARCHITECTURE §10 + CCR-4): next `count` execute() calls fail; optional
 * forcedFailure toggle. Omitting count defaults to 1 at the adapter (CCR-4).
 */
export const SandboxFailNextRequestSchema = z
	.object({
		providerId: RailId,
		count: z.number().int().positive().optional(),
		forcedFailure: z.boolean().optional(),
	})
	.strict();

export type SandboxFailNextRequest = z.infer<typeof SandboxFailNextRequestSchema>;

/** provider-health (ARCHITECTURE §10 + CCR-4 `setHealth`). */
export const SandboxProviderHealthRequestSchema = z
	.object({
		providerId: RailId,
		health: z.enum(["up", "down"]),
	})
	.strict();

export type SandboxProviderHealthRequest = z.infer<
	typeof SandboxProviderHealthRequestSchema
>;

/** reset (ARCHITECTURE §10, DEV_PLAN D2): no request fields are documented. */
export const SandboxResetRequestSchema = z.object({}).strict();

export type SandboxResetRequest = z.infer<typeof SandboxResetRequestSchema>;

/**
 * advance-time (CCR-6 accepted): move the **API clock** only (quote/claim expiry).
 * Does not move Stellar ledger time (CCR-5).
 */
export const SandboxAdvanceTimeRequestSchema = z
	.object({
		seconds: z.number().int().min(1).max(86400),
	})
	.strict();

export type SandboxAdvanceTimeRequest = z.infer<
	typeof SandboxAdvanceTimeRequestSchema
>;

/** Clock after the advance (ISO-8601). */
export const SandboxAdvanceTimeResponseSchema = z
	.object({
		now: IsoTimestamp,
	})
	.strict();

export type SandboxAdvanceTimeResponse = z.infer<
	typeof SandboxAdvanceTimeResponseSchema
>;
