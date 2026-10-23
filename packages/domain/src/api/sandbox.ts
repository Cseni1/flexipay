import { z } from "zod";
import { RailId } from "./common.ts";

// POST /v1/sandbox/* (ARCHITECTURE §10, CCR-4 SandboxControls). Demo-only controls.
// Only request fields named in those sources are contracted here. advance-time has no
// accepted body/response on main (CCR-6 proposal only) — see openapi-stubs.ts.

/** Shared ack used by sandbox controls that have no documented response body of their own. */
export const SandboxOkSchema = z.object({ status: z.literal("ok") }).strict();
export type SandboxOk = z.infer<typeof SandboxOkSchema>;

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
