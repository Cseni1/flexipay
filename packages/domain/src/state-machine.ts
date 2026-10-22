import type { LegKind, LegStatus, PaymentStatus } from "./enums.ts";

// Payment and leg state machine (ARCHITECTURE §7). Pure functions: the orchestrator (CC2)
// persists state and emits the events; this module only decides what is allowed and what is next.

const PAYMENT_TRANSITIONS: Record<PaymentStatus, readonly PaymentStatus[]> = {
  quoted: ["awaiting_funding", "cancelled", "expired"],
  awaiting_funding: ["funded", "cancelled", "expired"],
  funded: ["processing", "cancelled"],
  processing: ["paid", "failed", "refunding", "expired"],
  paid: [],
  cancelled: [],
  failed: ["refunding"],
  refunding: ["refunded", "failed"],
  refunded: [],
  expired: ["refunding", "refunded"],
};

const LEG_TRANSITIONS: Record<LegStatus, readonly LegStatus[]> = {
  pending: ["processing"],
  processing: ["succeeded", "failed"],
  succeeded: ["reversing"],
  failed: ["reversing"],
  reversing: ["reversed"],
  reversed: [],
};

export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus): boolean =>
  PAYMENT_TRANSITIONS[from].includes(to);

export const canTransitionLeg = (from: LegStatus, to: LegStatus): boolean =>
  LEG_TRANSITIONS[from].includes(to);

export class InvalidTransition extends Error {
  readonly entity: "payment" | "leg";
  readonly from: string;
  readonly to: string;

  constructor(entity: "payment" | "leg", from: string, to: string) {
    super(`invalid ${entity} transition ${from} -> ${to}`);
    this.name = "InvalidTransition";
    this.entity = entity;
    this.from = from;
    this.to = to;
  }
}

export function assertPaymentTransition(from: PaymentStatus, to: PaymentStatus): void {
  if (!canTransitionPayment(from, to)) throw new InvalidTransition("payment", from, to);
}

export function assertLegTransition(from: LegStatus, to: LegStatus): void {
  if (!canTransitionLeg(from, to)) throw new InvalidTransition("leg", from, to);
}

export interface LegState {
  kind: LegKind;
  status: LegStatus;
}

/** Position of the next leg to start, or undefined. Legs run strictly in order (§7). */
export function nextLegIndex(legs: readonly LegState[]): number | undefined {
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.status === "succeeded") continue;
    return leg.status === "pending" ? i : undefined;
  }
  return undefined;
}

/** A payment is paid only when its last leg succeeded, and so has every leg before it. */
export function isPaid(legs: readonly LegState[]): boolean {
  return legs.length > 0 && legs.every((l) => l.status === "succeeded");
}

/** True once a settle leg has succeeded: money is locked in the vault and a refund goes through it. */
export function isSettled(legs: readonly LegState[]): boolean {
  return legs.some((l) => l.kind === "settle" && l.status === "succeeded");
}

export type FailureAction =
  /** Retry once on the same provider. */
  | { action: "retry" }
  /** Try the next eligible payout provider from the routing alternatives. */
  | { action: "reroute"; providerId: string }
  /** Refund through the settlement adapter (vault refund), then reverse earlier legs. */
  | { action: "refund_vault" }
  /** Nothing settled yet: reverse the collect leg; no vault is involved. */
  | { action: "reverse_collect" };

export interface FailureContext {
  failedKind: LegKind;
  legs: readonly LegState[];
  /** Attempts already made on the failed leg's current provider (the first try counts as 1). */
  attemptsOnProvider: number;
  /** Eligible payout providers not yet tried, in routing order. */
  untriedProviders: readonly string[];
}

/**
 * What to do when a leg fails (§7): before settlement, reverse the collect leg; after settlement
 * a failed payout is retried once on the same provider, then re-routed to the next eligible
 * provider, and finally refunded through the vault with earlier legs reversed.
 */
export function decideOnFailure(ctx: FailureContext): FailureAction {
  if (!isSettled(ctx.legs) && ctx.failedKind !== "payout") return { action: "reverse_collect" };
  if (ctx.failedKind !== "payout") return { action: "refund_vault" };
  if (!isSettled(ctx.legs)) return { action: "reverse_collect" };
  if (ctx.attemptsOnProvider < 2) return { action: "retry" };
  const next = ctx.untriedProviders[0];
  return next === undefined ? { action: "refund_vault" } : { action: "reroute", providerId: next };
}

/** Event types (§9) written for a payment status change. */
export const PAYMENT_STATUS_EVENT: Partial<Record<PaymentStatus, string>> = {
  awaiting_funding: "payment.created",
  funded: "payment.funded",
  processing: "payment.processing",
  paid: "payment.paid",
  failed: "payment.failed",
  refunded: "payment.refunded",
  expired: "payment.expired",
};
