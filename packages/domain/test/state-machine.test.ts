import { describe, expect, it } from "vitest";
import {
  InvalidTransition,
  assertLegTransition,
  assertPaymentTransition,
  canTransitionLeg,
  canTransitionPayment,
  decideOnFailure,
  isPaid,
  isSettled,
  nextLegIndex,
  type LegState,
} from "../src/index.ts";

const legs = (...s: [LegState["kind"], LegState["status"]][]): LegState[] =>
  s.map(([kind, status]) => ({ kind, status }));

describe("payment transitions", () => {
  it("follows quoted -> awaiting_funding -> funded -> processing -> paid", () => {
    const path = ["quoted", "awaiting_funding", "funded", "processing", "paid"] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransitionPayment(path[i], path[i + 1])).toBe(true);
  });

  it("allows cancel only before processing", () => {
    expect(canTransitionPayment("funded", "cancelled")).toBe(true);
    expect(canTransitionPayment("processing", "cancelled")).toBe(false);
  });

  it("never leaves a terminal state", () => {
    for (const s of ["paid", "cancelled", "refunded"] as const) expect(canTransitionPayment(s, "processing")).toBe(false);
  });

  it("refunds through refunding, and expiry can refund", () => {
    expect(canTransitionPayment("processing", "refunding")).toBe(true);
    expect(canTransitionPayment("refunding", "refunded")).toBe(true);
    expect(canTransitionPayment("expired", "refunded")).toBe(true);
    expect(() => assertPaymentTransition("paid", "refunded")).toThrow(InvalidTransition);
  });
});

describe("leg transitions", () => {
  it("runs pending -> processing -> succeeded or failed, then reversing -> reversed", () => {
    expect(canTransitionLeg("pending", "processing")).toBe(true);
    expect(canTransitionLeg("processing", "succeeded")).toBe(true);
    expect(canTransitionLeg("failed", "reversing")).toBe(true);
    expect(canTransitionLeg("reversing", "reversed")).toBe(true);
    expect(canTransitionLeg("pending", "succeeded")).toBe(false);
    expect(() => assertLegTransition("reversed", "pending")).toThrow(/leg transition/);
  });
});

describe("leg ordering", () => {
  it("starts the first pending leg only after the previous one succeeded", () => {
    expect(nextLegIndex(legs(["collect", "pending"], ["payout", "pending"]))).toBe(0);
    expect(nextLegIndex(legs(["collect", "succeeded"], ["payout", "pending"]))).toBe(1);
    expect(nextLegIndex(legs(["collect", "processing"], ["payout", "pending"]))).toBeUndefined();
    expect(nextLegIndex(legs(["collect", "failed"], ["payout", "pending"]))).toBeUndefined();
    expect(nextLegIndex(legs(["collect", "succeeded"]))).toBeUndefined();
  });

  it("is paid only when every leg, including the last, succeeded", () => {
    expect(isPaid(legs(["collect", "succeeded"], ["payout", "succeeded"]))).toBe(true);
    expect(isPaid(legs(["collect", "succeeded"], ["payout", "processing"]))).toBe(false);
    expect(isPaid([])).toBe(false);
  });

  it("knows when money is settled in the vault", () => {
    expect(isSettled(legs(["collect", "succeeded"], ["settle", "succeeded"]))).toBe(true);
    expect(isSettled(legs(["collect", "succeeded"], ["settle", "processing"]))).toBe(false);
  });
});

describe("failure decisions (ARCHITECTURE §7)", () => {
  const settled = legs(["collect", "succeeded"], ["convert", "succeeded"], ["settle", "succeeded"], ["convert", "succeeded"], ["payout", "failed"]);

  it("reverses the collect leg when a leg fails before settlement", () => {
    const before = legs(["collect", "succeeded"], ["convert", "failed"], ["settle", "pending"]);
    expect(decideOnFailure({ failedKind: "convert", legs: before, attemptsOnProvider: 1, untriedProviders: [] })).toEqual({ action: "reverse_collect" });
  });

  it("retries a failed payout once on the same provider", () => {
    expect(decideOnFailure({ failedKind: "payout", legs: settled, attemptsOnProvider: 1, untriedProviders: ["other"] })).toEqual({ action: "retry" });
  });

  it("re-routes to the next eligible provider after the retry fails", () => {
    expect(decideOnFailure({ failedKind: "payout", legs: settled, attemptsOnProvider: 2, untriedProviders: ["other", "third"] })).toEqual({ action: "reroute", providerId: "other" });
  });

  it("refunds through the vault when no alternative is left", () => {
    expect(decideOnFailure({ failedKind: "payout", legs: settled, attemptsOnProvider: 2, untriedProviders: [] })).toEqual({ action: "refund_vault" });
  });

  it("refunds through the vault when a post-settlement leg other than payout fails", () => {
    expect(decideOnFailure({ failedKind: "convert", legs: settled, attemptsOnProvider: 1, untriedProviders: [] })).toEqual({ action: "refund_vault" });
  });

  it("reverses the collect leg for a domestic payout failure (nothing settled)", () => {
    const domestic = legs(["collect", "succeeded"], ["payout", "failed"]);
    expect(decideOnFailure({ failedKind: "payout", legs: domestic, attemptsOnProvider: 2, untriedProviders: [] })).toEqual({ action: "reverse_collect" });
  });
});
