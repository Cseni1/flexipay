import { EventListResponseSchema } from "@flexipay/domain";
import { ApiError } from "../errors.ts";
import { defineRoute, type RouteDef } from "../routes.ts";
import { toApiEvent } from "../serialize.ts";

export const eventRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/events",
		summary: "Event log",
		auth: "api_key",
		success: { status: 200, schema: EventListResponseSchema },
		handler: async (ctx) => {
			if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
			const rows = await ctx.db.event.findMany({
				where: { organizationId: ctx.org.id },
				orderBy: { createdAt: "desc" },
				take: 200,
			});
			return { events: rows.map(toApiEvent) };
		},
	}),
];
