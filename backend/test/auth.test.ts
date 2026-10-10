import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

describe("provider auth, health and the public surface", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("GET /health needs no key and reports the providers", async () => {
    const res = await request(t.app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.linkTtlDays).toBe(30);
    expect(res.body.providers).toMatchObject({ llm: "offline", speech: "offline", sql: "sqlite", docStore: "local", email: "console" });
  });

  it("every provider endpoint rejects a missing or wrong x-provider-key with 401", async () => {
    for (const [method, path] of [
      ["get", "/patients"],
      ["post", "/patients"],
      ["get", "/patients/pt-0001"],
      ["post", "/ingest"],
      ["get", "/jobs/abc"],
    ] as const) {
      const res = await request(t.app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error).toBe("provider_key_required");
      const wrong = await request(t.app)[method](path).set("x-provider-key", "wrong");
      expect(wrong.status, `${method} ${path} wrong key`).toBe(401);
    }
  });

  it("patient endpoints need no key but a well-formed link", async () => {
    const res = await request(t.app).get("/summary?link=not-a-link");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_link");
    const unknown = await request(t.app).get("/summary?link=AAAAAAAAAAAAAAAAAAAAAA");
    expect(unknown.status).toBe(404);
    expect(unknown.body.error).toBe("link_not_found");
  });

  it("surfaces outside the note and the diagram are gone", async () => {
    for (const path of ["/languages", "/checklist?link=AAAAAAAAAAAAAAAAAAAAAA", "/audit?link=AAAAAAAAAAAAAAAAAAAAAA"]) {
      const res = await t.provider(request(t.app).get(path));
      expect(res.status, path).toBe(404);
    }
    for (const path of ["/checklist/complete", "/admin/purge", "/admin/clock/advance", "/admin/clock/reset"]) {
      const res = await t.provider(request(t.app).post(path)).send({ days: 30 });
      expect(res.status, path).toBe(404);
    }
  });

  it("serves the OpenAPI document", async () => {
    const res = await request(t.app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
  });
});
