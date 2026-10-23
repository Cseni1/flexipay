import { z } from "zod";
import { IsoTimestamp, RailId } from "./common.ts";

// POST /v1/sandbox/* (ARCHITECTURE §10, CCR-4 SandboxControls). Demo-only controls.

export const SandboxOkSchema = z.object({ status: z.literal("ok") }).strict();
export type SandboxOk = z.infer<typeof SandboxOkSchema>;

/**
 * fail-next: next `count` execute() calls fail; optional forcedFailure toggle (ARCHITECTURE §10,
 * CCR-4). Omitting count defaults to 1 at the adapter.
 */
export const SandboxFailNextRequestSchema = z
  .object({
    providerId: RailId,
    count: z.number().int().positive().optional(),
    forcedFailure: z.boolean().optional(),
  })
  .strict();

export type SandboxFailNextRequest = z.infer<typeof SandboxFailNextRequestSchema>;

export const SandboxProviderHealthRequestSchema = z
  .object({
    providerId: RailId,
    health: z.enum(["up", "down"]),
  })
  .strict();

export type SandboxProviderHealthRequest = z.infer<typeof SandboxProviderHealthRequestSchema>;

/**
 * advance-time: move the API clock used for quote and claim expiry (§10). Does not move
 * ledger / vault time (CCR-5). Request shape proposed for integrator confirmation (CCR-6):
 * advance by a positive whole number of seconds.
 */
export const SandboxAdvanceTimeRequestSchema = z
  .object({
    seconds: z.number().int().positive(),
  })
  .strict();

export type SandboxAdvanceTimeRequest = z.infer<typeof SandboxAdvanceTimeRequestSchema>;

export const SandboxAdvanceTimeResponseSchema = z
  .object({
    status: z.literal("ok"),
    now: IsoTimestamp,
  })
  .strict();

export type SandboxAdvanceTimeResponse = z.infer<typeof SandboxAdvanceTimeResponseSchema>;

/** reset: clear sandbox overrides and reseed demo data (§10, DEV_PLAN D2). */
export const SandboxResetRequestSchema = z.object({}).strict();

export type SandboxResetRequest = z.infer<typeof SandboxResetRequestSchema>;
