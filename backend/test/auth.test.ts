import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

describe("auth and health", () => {
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
    expect(res.body.providers).toMatchObject({ llm: "offline", transcribe: "offline", docStore: "local", email: "console" });
  });

  it("every provider endpoint rejects a missing key with 401", async () => {
    for (const [method, path] of [
      ["get", "/patients"],
      ["post", "/patients"],
      ["post", "/ingest"],
      ["get", "/jobs/abc"],
      ["get", "/audit?link=x"],
      ["post", "/admin/purge"],
      ["post", "/admin/clock/advance"],
    ] as const) {
      const res = await request(t.app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.body.error).toBe("provider_key_required");
    }
  });

  it("patient endpoints need no key but a well-formed link", async () => {
    const res = await request(t.app).get("/summary?link=not-a-link");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_link");
    const unknown = await request(t.app).get("/summary?link=AAAAAAAAAAAAAAAAAAAAAA");
    expect(unknown.status).toBe(404);
  });

  it("admin endpoints disappear when DEMO_MODE=false", async () => {
    const prod = await createTestApp({ overrides: { DEMO_MODE: false } });
    const res = await prod.provider(request(prod.app).post("/admin/purge"));
    expect(res.status).toBe(404);
    await prod.close();
  });
});
