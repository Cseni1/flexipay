import { z } from "zod";
import { ROUTES } from "../app.ts";

// OpenAPI 3.1 built from the same route table that mounts the Express routes, using zod's own
// JSON Schema export. Request and response shapes therefore cannot differ from what is enforced.

const json = (schema: z.ZodType) => ({
  "application/json": { schema: z.toJSONSchema(schema, { target: "draft-2020-12", io: "output", unrepresentable: "any" }) },
});

const ERROR_SCHEMA = {
  type: "object",
  properties: { code: { type: "string" }, message: { type: "string" }, details: {} },
  required: ["code", "message"],
};

export function buildOpenApi() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const responses: Record<string, unknown> = {
      [r.success.status]: { description: "Success", content: json(r.success.schema) },
      "400": { description: "Invalid request", content: { "application/json": { schema: ERROR_SCHEMA } } },
    };
    if (r.auth === "api_key") {
      responses["401"] = { description: "Missing or invalid API key", content: { "application/json": { schema: ERROR_SCHEMA } } };
    }
    if (r.method === "post") {
      responses["409"] = { description: "Idempotency or state conflict", content: { "application/json": { schema: ERROR_SCHEMA } } };
    }
    paths[r.path] = {
      ...paths[r.path],
      [r.method]: {
        summary: r.summary,
        security: r.auth === "api_key" ? [{ bearerAuth: [] }] : [],
        ...(r.method === "post" ? { parameters: [{ name: "Idempotency-Key", in: "header", required: false, schema: { type: "string" } }] } : {}),
        ...(r.body ? { requestBody: { required: true, content: json(r.body) } } : {}),
        responses,
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "FlexiPay API", version: "1.0.0", description: "Testnet build. Simulated providers are labelled; no real money moves." },
    servers: [{ url: "/" }],
    components: { securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } } },
    paths,
  };
}
