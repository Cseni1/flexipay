import { z } from "zod";
import type { Provider } from "@flexipay/domain";
import { BlindPayAdapter, DueAdapter, TazapayAdapter } from "@flexipay/adapters-live";
import { ApiError } from "../errors.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

// CCR-35: operator view of registered partners. It deliberately returns only aggregate
// availability and instance metadata: never keys, account numbers or recipient data.

const PartnerBalance = z
  .object({ currency: z.string().min(1), amount: z.number().int() })
  .strict();

const PartnerStatus = z
  .object({
    id: z.string(),
    label: z.string(),
    mode: z.enum(["sandbox", "live"]),
    health: z.enum(["up", "down"]),
    /** Tazapay only, in hundredths of each currency. */
    balances: z.array(PartnerBalance).optional(),
    /** BlindPay only. */
    instanceType: z.enum(["development", "production"]).optional(),
  })
  .strict();

const PartnerList = z.object({ partners: z.array(PartnerStatus) }).strict();

const PARTNER_LABELS: Readonly<Record<string, string>> = {
  blindpay_sandbox: "BlindPay",
  tazapay_sandbox: "Tazapay",
  due_sandbox: "Due",
};

function labelFor(row: Provider | undefined, id: string): string {
  const known = PARTNER_LABELS[id];
  if (known) return known;
  if (row?.implementation === "blindpay") return "BlindPay";
  if (row?.implementation === "tazapay") return "Tazapay";
  if (row?.implementation === "due") return "Due";
  return id;
}

export const opsRoutes: RouteDef<any, any>[] = [
  defineRoute({
    method: "get",
    path: "/v1/ops/partners",
    summary: "Registered partners with mode, health and Tazapay available balances",
    auth: "api_key",
    success: { status: 200, schema: PartnerList },
    handler: async (ctx) => {
      if (!ctx.runtime) {
        throw new ApiError(500, "internal_error", "runtime not configured");
      }
      // FlexiPay's partner balances are not for customers: every customer org has an api_key, so
      // only orgs listed in FP_OPERATOR_ORG_IDS may read this route; everyone else gets 404.
      const operators = (process.env.FP_OPERATOR_ORG_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean);
      if (!ctx.org || !operators.includes(ctx.org.id)) {
        throw new ApiError(404, "not_found", "Not found");
      }
      const partners: Array<z.infer<typeof PartnerStatus>> = [];
      for (const id of ctx.runtime.liveProviderIds ?? []) {
        const adapter = ctx.runtime.getProvider(id);
        if (!adapter) continue;
        const row = ctx.config.providers.find((p) => p.id === id);
        const health = await adapter.health();
        if (adapter instanceof TazapayAdapter) {
          let balances: Array<{ currency: string; amount: number }> | undefined;
          try {
            balances = await adapter.balances();
          } catch {
            // The partner's balance API can be down while the route stays useful for health.
            balances = undefined;
          }
          partners.push({
            id,
            label: labelFor(row, id),
            mode: adapter.mode(),
            health,
            ...(balances ? { balances } : {}),
          });
        } else if (adapter instanceof BlindPayAdapter) {
          const instanceType = await adapter.instanceType();
          partners.push({
            id,
            label: labelFor(row, id),
            mode: instanceType === "development" ? "sandbox" : "live",
            health,
            instanceType,
          });
        } else if (adapter instanceof DueAdapter) {
          partners.push({ id, label: labelFor(row, id), mode: adapter.mode(), health });
        }
      }
      return { partners };
    },
  }),
];
