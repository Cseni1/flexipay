import { z } from "zod";
import {
	CreateEndpointRequestSchema,
	EndpointListResponseSchema,
	EndpointSchema,
	type Endpoint,
} from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { newId } from "../ids.ts";
import { maskDetails } from "../mask.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

const orgOf = (ctx: { org?: { id: string } }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

const ListQuery = z.object({ recipientId: z.string().min(1).optional() }).strict();

export function toEndpoint(row: {
	id: string;
	organizationId: string;
	recipientId: string | null;
	type: string;
	country: string | null;
	currency: string;
	network: string | null;
	details: unknown;
	createdAt: Date;
}): Endpoint {
	return EndpointSchema.parse({
		id: row.id,
		organizationId: row.organizationId,
		// Only endpoints created through this route (or a claim) are linked to a recipient.
		recipientId: row.recipientId ?? "",
		type: row.type,
		country: row.country ?? "",
		currency: row.currency,
		network: row.network,
		details: maskDetails(row.details),
		simulated: true,
		createdAt: row.createdAt.toISOString(),
	});
}

export const endpointRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "post",
		path: "/v1/endpoints",
		summary: "Create a destination endpoint for a recipient",
		auth: "api_key",
		body: CreateEndpointRequestSchema,
		success: { status: 201, schema: EndpointSchema },
		handler: async (ctx, { body }) => {
			const org = orgOf(ctx);
			const recipient = await ctx.db.recipient.findFirst({
				where: { id: body.recipientId, organizationId: org.id },
			});
			if (!recipient) throw new ApiError(404, "not_found", "Recipient not found");
			const row = await ctx.db.endpoint.create({
				data: {
					id: newId("end"),
					organizationId: org.id,
					recipientId: recipient.id,
					type: body.type,
					country: body.country,
					currency: body.currency,
					network: body.network,
					details: body.details,
					simulated: true,
				},
			});
			return toEndpoint(row);
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/endpoints",
		summary: "List endpoints, optionally for one recipient",
		auth: "api_key",
		query: ListQuery,
		success: { status: 200, schema: EndpointListResponseSchema },
		handler: async (ctx, { query }) => {
			const org = orgOf(ctx);
			const rows = await ctx.db.endpoint.findMany({
				where: {
					organizationId: org.id,
					...(query?.recipientId ? { recipientId: query.recipientId } : {}),
				},
				orderBy: { createdAt: "desc" },
			});
			return { endpoints: rows.map(toEndpoint) };
		},
	}),
];
