import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { A0_OPENAPI_STUBS } from "@flexipay/domain";
import { coreRoutes } from "../src/routes/core.ts";
import { buildOpenApi, stubsNotYetMounted } from "../src/openapi/spec.ts";

const ROUTES = coreRoutes;

describe("OpenAPI", () => {
  const doc = buildOpenApi();
  const stubs = stubsNotYetMounted();

  it("lists every mounted route", () => {
    for (const r of ROUTES) expect(doc.paths[r.path]?.[r.method], `${r.method} ${r.path}`).toBeDefined();
  });

  it("lists every A0 contract stub not yet mounted", () => {
    for (const s of stubs) expect(doc.paths[s.path]?.[s.method], `stub ${s.method} ${s.path}`).toBeDefined();
    expect(stubs.length).toBe(A0_OPENAPI_STUBS.length);
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

  it("documents sandbox stubs without contracted response bodies", () => {
    for (const path of [
      "/v1/sandbox/fail-next",
      "/v1/sandbox/provider-health",
      "/v1/sandbox/advance-time",
      "/v1/sandbox/reset",
    ]) {
      const op = doc.paths[path].post as any;
      expect(op.responses["200"].content, path).toBeUndefined();
    }
    expect(
      (doc.paths["/v1/sandbox/advance-time"].post as { requestBody?: unknown })
        .requestBody,
    ).toBeUndefined();
    expect(
      (doc.paths["/v1/sandbox/fail-next"].post as { requestBody?: unknown })
        .requestBody,
    ).toBeDefined();
  });

  it("matches the committed openapi.json (run: npm run openapi --workspace @flexipay/api)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8");
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});
