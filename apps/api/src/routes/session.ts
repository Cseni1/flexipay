import { z } from "zod";
import { ApiError } from "../errors.ts";
import { newApiKey, newId } from "../ids.ts";
import { defineRoute, type RouteDef } from "../routes.ts";

// TASK 06: who am I, and API-key management for signed-in customers.
// API keys are machine credentials; only a customer session can mint or revoke them, so a
// leaked key can never create further keys.

const Me = z
	.object({
		via: z.enum(["api_key", "session"]),
		organization: z.object({ id: z.string(), name: z.string() }).strict(),
		user: z.object({ id: z.string(), email: z.string(), name: z.string() }).strict().nullable(),
	})
	.strict();

const KeyRow = z
	.object({
		id: z.string(),
		prefix: z.string(),
		label: z.string().nullable(),
		createdAt: z.string(),
		revokedAt: z.string().nullable(),
	})
	.strict();

const CreatedKey = KeyRow.extend({ key: z.string() }).strict();

const needOrg = (ctx: { org?: { id: string; name: string } }) => {
	if (!ctx.org) throw new ApiError(401, "unauthorized", "missing organization");
	return ctx.org;
};

const toRow = (k: { id: string; prefix: string; label: string | null; createdAt: Date; revokedAt: Date | null }) => ({
	id: k.id,
	prefix: k.prefix,
	label: k.label,
	createdAt: k.createdAt.toISOString(),
	revokedAt: k.revokedAt ? k.revokedAt.toISOString() : null,
});

export const sessionRoutes: RouteDef<any, any>[] = [
	defineRoute({
		method: "get",
		path: "/v1/me",
		summary: "The caller's organization (and user, for a customer session)",
		auth: "customer",
		success: { status: 200, schema: Me },
		handler: async (ctx) => {
			const org = needOrg(ctx);
			const a = ctx.actor;
			return {
				via: a?.kind ?? "api_key",
				organization: { id: org.id, name: org.name },
				user:
					a?.kind === "session" ? { id: a.userId, email: a.email, name: a.name } : null,
			};
		},
	}),
	defineRoute({
		method: "get",
		path: "/v1/api-keys",
		summary: "List this organization's API keys (never the secret)",
		auth: "session",
		success: { status: 200, schema: z.object({ keys: z.array(KeyRow) }).strict() },
		handler: async (ctx) => {
			const org = needOrg(ctx);
			const rows = await ctx.db.apiKey.findMany({
				where: { organizationId: org.id },
				orderBy: { createdAt: "desc" },
			});
			return { keys: rows.map(toRow) };
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/api-keys",
		summary: "Create an API key; the secret is shown once",
		auth: "session",
		body: z.object({ label: z.string().min(1).max(100).optional() }).strict(),
		success: { status: 201, schema: CreatedKey },
		handler: async (ctx, { body }) => {
			const org = needOrg(ctx);
			const k = newApiKey();
			const row = await ctx.db.apiKey.create({
				data: {
					id: newId("key"),
					organizationId: org.id,
					prefix: k.prefix,
					keyHash: k.keyHash,
					label: body.label ?? null,
				},
			});
			return { ...toRow(row), key: k.key };
		},
	}),
	defineRoute({
		method: "post",
		path: "/v1/api-keys/{id}/revoke",
		summary: "Revoke an API key of this organization",
		auth: "session",
		body: z.object({}).strict(),
		success: { status: 200, schema: KeyRow },
		handler: async (ctx, { params }) => {
			const org = needOrg(ctx);
			const key = await ctx.db.apiKey.findFirst({
				where: { id: params.id!, organizationId: org.id },
			});
			if (!key) throw new ApiError(404, "not_found", "API key not found");
			const row = key.revokedAt
				? key
				: await ctx.db.apiKey.update({ where: { id: key.id }, data: { revokedAt: new Date() } });
			return toRow(row);
		},
	}),
];
