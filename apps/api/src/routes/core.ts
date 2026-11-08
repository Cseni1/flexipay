import { z } from "zod";
import {
  CorridorSchema,
  CreateRecipientRequestSchema,
  CurrencyCode,
  RECIPIENT_KINDS,
  RecipientListResponseSchema,
  RecipientSchema,
  CountryCode,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { newId } from "../ids.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

const Health = z.object({ status: z.literal("ok") }).strict();

const PayoutRequirementsQuery = z
  .object({
    country: CountryCode,
    currency: CurrencyCode,
  })
  .strict();

const PayoutRequirementsResponse = z
  .object({
    country: CountryCode,
    currency: CurrencyCode,
    providerId: z.string().nullable(),
    detailKeys: z.array(z.string()),
    localFields: z.array(z.string()),
    addressRequired: z.boolean(),
  })
  .strict();

type RecipientRow = {
  id: string;
  name: string;
  kind: string;
  country: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressPostalCode: string | null;
  createdAt: Date;
};

const toRecipient = (r: RecipientRow) => ({
  id: r.id,
  name: r.name,
  kind: r.kind as (typeof RECIPIENT_KINDS)[number],
  country: r.country,
  address:
    r.addressLine1 && r.addressCity && r.addressState && r.addressPostalCode
      ? {
          line1: r.addressLine1,
          line2: r.addressLine2,
          city: r.addressCity,
          state: r.addressState,
          postalCode: r.addressPostalCode,
          country: r.country,
        }
      : null,
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
    auth: "customer",
    success: { status: 200, schema: z.object({ corridors: z.array(CorridorSchema) }).strict() },
    handler: async (ctx) => ({ corridors: ctx.config.corridors }),
  }),
  defineRoute({
    method: "post",
    path: "/v1/recipients",
    summary: "Create a recipient",
    auth: "customer",
    body: CreateRecipientRequestSchema,
    success: { status: 201, schema: RecipientSchema },
    handler: async (ctx, { body }) => {
      const org = orgOf(ctx);
      const row = await ctx.db.recipient.create({
        data: {
          id: newId("rcp"),
          organizationId: org.id,
          name: body.name,
          kind: body.kind,
          country: body.country,
          addressLine1: body.address?.line1 ?? null,
          addressLine2: body.address?.line2 ?? null,
          addressCity: body.address?.city ?? null,
          addressState: body.address?.state ?? null,
          addressPostalCode: body.address?.postalCode ?? null,
        },
      });
      return toRecipient(row);
    },
  }),
  defineRoute({
    method: "get",
    path: "/v1/payout-requirements",
    summary: "Partner payout fields required for a destination country (CCR-43)",
    auth: "customer",
    query: PayoutRequirementsQuery,
    success: { status: 200, schema: PayoutRequirementsResponse },
    handler: async (ctx, { query }) => {
      orgOf(ctx);
      const empty = {
        country: query.country,
        currency: query.currency,
        providerId: null as string | null,
        detailKeys: [] as string[],
        localFields: [] as string[],
        addressRequired: false,
      };
      const ids = ctx.runtime?.liveProviderIds ?? [];
      for (const id of ids) {
        const provider = ctx.runtime?.getProvider(id);
        if (!provider?.payoutRequirements) continue;
        const caps = provider.capabilities();
        if (
          caps.countries.length > 0 &&
          !caps.countries.includes(query.country)
        ) {
          continue;
        }
        const requirements = await provider.payoutRequirements(
          query.country,
          query.currency,
        );
        if (!requirements) continue;
        return {
          country: query.country,
          currency: query.currency,
          providerId: id,
          detailKeys: requirements.detailKeys,
          localFields: requirements.localFields,
          addressRequired: requirements.localFields.some((field) =>
            field.startsWith("address."),
          ),
        };
      }
      return empty;
    },
  }),
  defineRoute({
    method: "get",
    path: "/v1/recipients",
    summary: "List recipients",
    auth: "customer",
    success: { status: 200, schema: RecipientListResponseSchema },
    handler: async (ctx) => {
      const org = orgOf(ctx);
      const rows = await ctx.db.recipient.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: "desc" } });
      return { recipients: rows.map(toRecipient) };
    },
  }),
];
