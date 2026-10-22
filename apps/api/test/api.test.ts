import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { auth, startTestServer, type TestServer } from "./helpers.ts";

let t: TestServer;
let key: string;

beforeAll(async () => {
  t = await startTestServer();
  key = (await t.newOrg()).key;
}, 180_000);

afterAll(async () => {
  await t.stop();
});

const post = (path: string, body: unknown, headers: Record<string, string> = {}, k = key) =>
  fetch(t.base + path, { method: "POST", headers: auth(k, headers), body: JSON.stringify(body) });

describe("API skeleton", () => {
  it("answers the health check without a key", async () => {
    const res = await fetch(`${t.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects missing, malformed and unknown API keys with 401", async () => {
    for (const headers of [{} as Record<string, string>, { authorization: "Basic abc" }, { authorization: "Bearer fp_test_nope" }]) {
      const res = await fetch(`${t.base}/v1/corridors`, { headers });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe("unauthorized");
    }
  });

  it("serves the four baseline corridors from config", async () => {
    const res = await fetch(`${t.base}/v1/corridors`, { headers: auth(key) });
    expect(res.status).toBe(200);
    const { corridors } = await res.json();
    expect(corridors.map((c: any) => `${c.from.country}-${c.to.country}`)).toEqual(["US-US", "US-PH", "US-BR", "US-ZA"]);
    const za = corridors.find((c: any) => c.to.country === "ZA");
    expect(za.cryptoLegAllowed).toEqual({ individual: false, company: false });
    expect(za.simulated).toBe(true);
  });

  it("validates bodies with a 400 and an error code", async () => {
    const res = await post("/v1/recipients", { name: "Worker A", kind: "robot", country: "PH" });
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("validation_error");
    expect((await post("/v1/recipients", { name: "Worker A", kind: "individual", country: "PH", extra: 1 })).status).toBe(400);
  });

  it("returns 404 with an error body for unknown routes", async () => {
    const res = await fetch(`${t.base}/v1/nope`, { headers: auth(key) });
    expect(res.status).toBe(404);
    expect((await res.json()).code).toBe("not_found");
  });

  it("creates and lists recipients per organization", async () => {
    const created = await post("/v1/recipients", { name: "Worker A", kind: "individual", country: "PH" });
    expect(created.status).toBe(201);
    const worker = await created.json();
    expect(worker.id).toMatch(/^rcp_/);

    const mine = await (await fetch(`${t.base}/v1/recipients`, { headers: auth(key) })).json();
    expect(mine.recipients.map((r: any) => r.id)).toContain(worker.id);

    const other = await t.newOrg("Other Platform");
    const theirs = await (await fetch(`${t.base}/v1/recipients`, { headers: auth(other.key) })).json();
    expect(theirs.recipients).toEqual([]);
  });

  it("replays a POST with the same Idempotency-Key and rejects a different body with 409", async () => {
    const headers = { "idempotency-key": "idem-1" };
    const body = { name: "Worker B", kind: "individual", country: "BR" };
    const first = await post("/v1/recipients", body, headers);
    const second = await post("/v1/recipients", body, headers);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect((await second.json()).id).toBe((await first.json()).id);

    const conflict = await post("/v1/recipients", { ...body, name: "Worker C" }, headers);
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("idempotency_conflict");

    const list = await (await fetch(`${t.base}/v1/recipients`, { headers: auth(key) })).json();
    expect(list.recipients.filter((r: any) => r.name === "Worker B")).toHaveLength(1);
  });

  it("stores API keys only as hashes", async () => {
    const keys = await t.db.apiKey.findMany();
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      expect(k.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(k)).not.toContain(key);
    }
  });
});
