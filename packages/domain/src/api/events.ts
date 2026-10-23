import { z } from "zod";
import { IsoTimestamp } from "./common.ts";

// GET /v1/events (ARCHITECTURE §9, §10). Webhook delivery is deferred (CCR-5); events are stored
// and read through this list.

export const EVENT_TYPES = [
  "payment.created",
  "payment.funded",
  "payment.processing",
  "leg.succeeded",
  "leg.failed",
  "payment.onchain",
  "payment.paid",
  "payment.failed",
  "payment.refunded",
  "payment.expired",
  "claim.opened",
  "claim.accepted",
  "batch.completed",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];
export const EventTypeSchema = z.enum(EVENT_TYPES);

export const EventSchema = z
  .object({
    id: z.string().min(1),
    type: EventTypeSchema,
    createdAt: IsoTimestamp,
    paymentId: z.string().min(1).nullable(),
    /** Snapshot of the payment at the time of the event (§9). */
    snapshot: z.record(z.string(), z.unknown()),
  })
  .strict();

export type Event = z.infer<typeof EventSchema>;

export const EventListResponseSchema = z
  .object({
    events: z.array(EventSchema),
  })
  .strict();

export type EventListResponse = z.infer<typeof EventListResponseSchema>;
