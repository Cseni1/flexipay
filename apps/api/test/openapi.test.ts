import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { A0_OPENAPI_STUBS } from "@flexipay/domain";
import { ROUTES } from "../src/app.ts";
import { buildOpenApi, stubsNotYetMounted } from "../src/openapi/spec.ts";

/** CCR-20: deploy mounted (M2); prepare/submit still stubs until step 2. */
const CCR20_UNMOUNTED_PASSKEY = [
  "post /v1/claims/{token}/passkey/prepare",
  "post /v1/claims/{token}/passkey/submit",
] as const;

/** Repo root for this worktree: apps/api/test → ../../.. */
const WORKTREE_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const EXPECTED_DOMAIN_ENTRY = resolve(
  WORKTREE_ROOT,
  "packages/domain/src/index.ts",
);

describe("OpenAPI", () => {
  const doc = buildOpenApi();
  const stubs = stubsNotYetMounted();

  it("resolves @flexipay/domain from this worktree (not another checkout)", () => {
    const resolved = fileURLToPath(import.meta.resolve("@flexipay/domain"));
    expect(resolve(resolved)).toBe(EXPECTED_DOMAIN_ENTRY);
    expect(pathToFileURL(resolved).href.startsWith(pathToFileURL(WORKTREE_ROOT).href)).toBe(
      true,
    );
  });

  it("lists every mounted route", () => {
    for (const r of ROUTES) expect(doc.paths[r.path]?.[r.method], `${r.method} ${r.path}`).toBeDefined();
  });

  it("documents every A0 contract stub, mounted or not", () => {
    for (const s of A0_OPENAPI_STUBS) {
      expect(doc.paths[s.path]?.[s.method], `stub ${s.method} ${s.path}`).toBeDefined();
    }
    const mounted = new Set(ROUTES.map((r) => `${r.method}:${r.path}`));
    const unmounted = A0_OPENAPI_STUBS.filter((s) => !mounted.has(`${s.method}:${s.path}`));
    expect(stubs.length).toBe(unmounted.length);
  });

  it("keeps CC3 + passkey deploy mounted; prepare/submit stubs remain unmounted", () => {
    expect(stubs.map((s) => `${s.method} ${s.path}`).sort()).toEqual(
      [...CCR20_UNMOUNTED_PASSKEY].sort(),
    );
    expect(
      ROUTES.some(
        (r) => r.method === "post" && r.path === "/v1/claims/{token}/passkey/deploy",
      ),
    ).toBe(true);
  });

  it("documents passkey submit 200 released and 202 pending without releaseTxRef on 202", () => {
    const op = doc.paths["/v1/claims/{token}/passkey/submit"].post as {
      responses: Record<string, { content?: { "application/json": { schema: { required?: string[]; properties?: Record<string, unknown> } } } }>;
    };
    expect(op.responses["200"]).toBeDefined();
    expect(op.responses["202"]).toBeDefined();
    const released = op.responses["200"].content!["application/json"].schema;
    const pending = op.responses["202"].content!["application/json"].schema;
    expect(released.required).toEqual(
      expect.arrayContaining(["claim", "paymentId", "paymentStatus", "releaseTxRef"]),
    );
    expect(pending.required).toEqual(
      expect.arrayContaining(["status", "prepareId", "paymentId", "paymentStatus", "pendingTxHash"]),
    );
    expect(pending.required ?? []).not.toContain("releaseTxRef");
    expect(pending.properties?.releaseTxRef).toBeUndefined();
  });

  it("documents mounted routes plus A0 stubs with no duplicates", () => {
    const documented = Object.values(doc.paths).flatMap((p) => Object.keys(p)).length;
    expect(documented).toBe(ROUTES.length + stubs.length);
  });

  it("describes the error responses and the bearer scheme", () => {
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    const post = doc.paths["/v1/recipients"].post as any;
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(["201", "400", "401", "409"]));
    expect(post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
  });

  it("describes the A0 quote stub body", () => {
    const quote = doc.paths["/v1/quotes"].post as any;
    expect(quote.summary).toMatch(/Quote/i);
    expect(quote.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
  });

  it("does not overwrite mounted route docs with stubs", () => {
    const recipients = doc.paths["/v1/recipients"].post as any;
    expect(recipients.summary).toBe("Create a recipient");
    expect(Object.keys(recipients.responses).sort()).toEqual(["201", "400", "401", "409"]);
  });

  it("documents advance-time with the CCR-6 request and response", () => {
    const op = doc.paths["/v1/sandbox/advance-time"].post as any;
    const request = op.requestBody.content["application/json"].schema;
    expect(request.additionalProperties).toBe(false);
    expect(request.properties.seconds).toMatchObject({ type: "integer", minimum: 1, maximum: 86400 });
    const response = op.responses["200"].content["application/json"].schema;
    expect(Object.keys(response.properties)).toEqual(["now"]);
  });

  it("keeps the other sandbox responses to an empty object (no contracted body)", () => {
    for (const path of ["/v1/sandbox/fail-next", "/v1/sandbox/provider-health", "/v1/sandbox/reset"]) {
      const op = doc.paths[path].post as any;
      const schema = op.responses["200"].content["application/json"].schema;
      expect(schema.properties ?? {}, path).toEqual({});
    }
    expect((doc.paths["/v1/sandbox/fail-next"].post as { requestBody?: unknown }).requestBody).toBeDefined();
  });

  it("documents path and query parameters from the route table", () => {
    const get = doc.paths["/v1/batches/{id}"].get as any;
    expect(get.parameters).toEqual([{ name: "id", in: "path", required: true, schema: { type: "string" } }]);
    const list = doc.paths["/v1/endpoints"].get as any;
    expect(list.parameters).toEqual([
      expect.objectContaining({ name: "recipientId", in: "query", required: false }),
    ]);
    const create = doc.paths["/v1/batches"].post as any;
    expect(create.requestBody.content["application/json"].schema.properties.rows.maxItems).toBe(50);
  });

  it("matches the committed openapi.json (run: npm run openapi --workspace @flexipay/api)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8");
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});
