import { z } from "zod";
import { RailId } from "./common.ts";

// POST /v1/sandbox/* (ARCHITECTURE §10, CCR-4 SandboxControls). Demo-only controls.
// Only request fields named in those sources are contracted here. No response bodies are
// accepted for sandbox routes on main — OpenAPI stubs omit success schemas.
// advance-time request body: see CCR-6 (sandbox clock). Not yet contracted.

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
