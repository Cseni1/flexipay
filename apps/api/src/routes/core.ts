import { z } from "zod";
import { CorridorSchema, RECIPIENT_KINDS } from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

const Health = z.object({ status: z.literal("ok") }).strict();

const RecipientBody = z
  .object({
    name: z.string().min(1).max(200),
    kind: z.enum(RECIPIENT_KINDS),
    country: z.string().regex(/^[A-Z]{2}$/),
  })
  .strict();

const Recipient = z
  .object({ id: z.string(), name: z.string(), kind: z.enum(RECIPIENT_KINDS), country: z.string(), createdAt: z.string() })
  .strict();

const toRecipient = (r: { id: string; name: string; kind: string; country: string; createdAt: Date }) => ({
  id: r.id,
  name: r.name,
  kind: r.kind as (typeof RECIPIENT_KINDS)[number],
  country: r.country,
  createdAt: r.createdAt.toISOString(),
});

const orgOf = (ctx: { org?: { id: string } }) => {
  if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
  return ctx.org;
};

export const coreRoutes: RouteDef<any, any>[] = [
  defineRoute({
    method: "get",
    path: "/healthz",
    summary: "Liveness check",
    auth: "none",
    success: { status: 200, schema: Health },
    handler: async () => ({ status: "ok" }),
  }),
  defineRoute({
    method: "get",
    path: "/v1/corridors",
    summary: "Corridors, allowed endpoint types, limits and notes",
    auth: "api_key",
    success: { status: 200, schema: z.object({ corridors: z.array(CorridorSchema) }).strict() },
    handler: async (ctx) => ({ corridors: ctx.config.corridors }),
  }),
  defineRoute({
    method: "post",
    path: "/v1/recipients",
    summary: "Create a recipient",
    auth: "api_key",
    body: RecipientBody,
    success: { status: 201, schema: Recipient },
    handler: async (ctx, { body }) => {
      const org = orgOf(ctx);
      const row = await ctx.db.recipient.create({
        data: { id: newId("rcp"), organizationId: org.id, name: body.name, kind: body.kind, country: body.country },
      });
      return toRecipient(row);
    },
  }),
  defineRoute({
    method: "get",
    path: "/v1/recipients",
    summary: "List recipients",
    auth: "api_key",
    success: { status: 200, schema: z.object({ recipients: z.array(Recipient) }).strict() },
    handler: async (ctx) => {
      const org = orgOf(ctx);
      const rows = await ctx.db.recipient.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } });
      return { recipients: rows.map(toRecipient) };
    },
  }),
];
