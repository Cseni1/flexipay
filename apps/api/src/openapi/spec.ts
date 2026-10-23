import { z } from "zod";
import { A0_OPENAPI_STUBS, type ApiOpenApiStub } from "@flexipay/domain";
import { ROUTES } from "../app.ts";

// OpenAPI 3.1: mounted Express routes plus A0 contract stubs (DEV_PLAN A0) so web/script lanes
// can build against the same document before CC3 implements handlers.

const json = (schema: z.ZodType) => ({
  "application/json": {
    schema: z.toJSONSchema(schema, { target: "draft-2020-12", io: "output", unrepresentable: "any" }),
  },
});

const ERROR_SCHEMA = {
  type: "object",
  properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
  required: ["code", "message"],
};

type PathOp = {
  method: "get" | "post";
  path: string;
  summary: string;
  auth: "api_key" | "none";
  body?: z.ZodType;
  success: { status: 200 | 201; schema?: z.ZodType };
};

function addPath(
  paths: Record<string, Record<string, unknown>>,
  r: PathOp,
  opts: { include422?: boolean } = {},
) {
  const responses: Record<string, unknown> = {
    [r.success.status]: {
      description: "Success",
      ...(r.success.schema ? { content: json(r.success.schema) } : {}),
    },
    "400": { description: "Invalid request", content: { "application/json": { schema: ERROR_SCHEMA } } },
  };
  if (r.auth === "api_key") {
    responses["401"] = {
      description: "Missing or invalid API key",
      content: { "application/json": { schema: ERROR_SCHEMA } },
    };
  }
  if (r.method === "post") {
    responses["409"] = {
      description: "Idempotency or state conflict",
      content: { "application/json": { schema: ERROR_SCHEMA } },
    };
  }
  if (opts.include422) {
    responses["422"] = {
      description: "Not eligible or business-rule failure",
      content: { "application/json": { schema: ERROR_SCHEMA } },
    };
  }
  const pathItem = {
    summary: r.summary,
    security: r.auth === "api_key" ? [{ bearerAuth: [] }] : [],
    ...(r.method === "post"
      ? {
          parameters: [
            { name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } },
          ],
        }
      : {}),
    ...(r.body ? { requestBody: { required: true, content: json(r.body) } } : {}),
    responses,
  };
  paths[r.path] = { ...paths[r.path], [r.method]: pathItem };
}

/** Stubs for paths not yet mounted. When CC3 adds a real route, the mounted route wins. */
function stubsNotYetMounted(): ApiOpenApiStub[] {
  const mounted = new Set(ROUTES.map((r) => `${r.method}:${r.path}`));
  return A0_OPENAPI_STUBS.filter((s) => !mounted.has(`${s.method}:${s.path}`));
}

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) addPath(paths, r);
  for (const s of stubsNotYetMounted()) addPath(paths, s, { include422: true });
  return {
    openapi: "3.1.0",
    info: {
      title: "FlexiPay API",
      version: "1.0.0",
      description: "Testnet build. Simulated providers are labelled; no real money moves.",
    },
    servers: [{ url: "/" }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths,
  };
}

export { stubsNotYetMounted };
