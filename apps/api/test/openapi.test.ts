import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ROUTES } from "../src/app.ts";
import { buildOpenApi } from "../src/openapi/spec.ts";

describe("OpenAPI", () => {
  const doc = buildOpenApi();

  it("lists every mounted route", () => {
    for (const r of ROUTES) expect(doc.paths[r.path]?.[r.method], `${r.method} ${r.path}`).toBeDefined();
    const documented = Object.values(doc.paths).flatMap((p) => Object.keys(p)).length;
    expect(documented).toBe(ROUTES.length);
  });

  it("describes the error responses and the bearer scheme", () => {
    expect(doc.components.securitySchemes.bearerAuth.scheme).toBe("bearer");
    const post = doc.paths["/v1/recipients"].post as any;
    expect(Object.keys(post.responses)).toEqual(expect.arrayContaining(["201", "400", "401", "409"]));
    expect(post.requestBody.content["application/json"].schema.additionalProperties).toBe(false);
  });

  it("matches the committed openapi.json (run: npm run openapi --workspace @flexipay/api)", () => {
    const committed = readFileSync(fileURLToPath(new URL("../openapi.json", import.meta.url)), "utf8");
    expect(committed).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });
});
