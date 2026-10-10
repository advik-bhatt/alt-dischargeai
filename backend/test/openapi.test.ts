import { readFileSync } from "node:fs";
import request from "supertest";
import YAML from "yaml";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OPENAPI_FILE } from "../src/app.js";
import { AI_OUTPUT_KEYS } from "../src/contracts/aiOutput.js";
import { createTestApp, type TestApp } from "./helpers.js";

/** The whole public surface of this branch: the note's endpoints plus the diagram's additions, nothing else. */
const SURFACE: Record<string, string[]> = {
  "/health": ["get"],
  "/patients": ["get", "post"],
  "/patients/{id}": ["get"],
  "/ingest": ["post"],
  "/jobs/{jobId}": ["get"],
  "/synthesize": ["post"],
  "/summary": ["get"],
  "/translate": ["get"],
  "/p/{token}": ["get"],
};

describe("OpenAPI document", () => {
  let t: TestApp;
  const doc = YAML.parse(readFileSync(OPENAPI_FILE, "utf8")) as { openapi: string; paths: Record<string, Record<string, unknown>>; components: { schemas: Record<string, { required?: string[]; additionalProperties?: boolean }> } };
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("documents exactly the mounted routes and methods", () => {
    const documented = Object.fromEntries(Object.entries(doc.paths).map(([p, ops]) => [p, Object.keys(ops).filter((k) => ["get", "post", "put", "patch", "delete"].includes(k)).sort()]));
    expect(documented).toEqual(SURFACE);
  });

  it("every documented route answers (no 404 from the router)", async () => {
    for (const [path, methods] of Object.entries(SURFACE)) {
      const url = path.replace("{id}", "pt-0001").replace("{jobId}", "nope").replace("{token}", "AAAAAAAAAAAAAAAAAAAAAA");
      for (const method of methods) {
        const res = await t.provider(request(t.app)[method as "get" | "post"](url)).send({});
        expect(res.status, `${method} ${path}`).not.toBe(404 === res.status && res.body?.error === "not_found" ? 404 : -1);
        expect(res.body?.error, `${method} ${path}`).not.toBe("not_found");
      }
    }
  });

  it("the AiOutput schema matches the contract and is served at /openapi.json", async () => {
    expect(doc.components.schemas.AiOutput.required).toEqual([...AI_OUTPUT_KEYS]);
    expect(doc.components.schemas.AiOutput.additionalProperties).toBe(false);
    const res = await request(t.app).get("/openapi.json");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body.paths).sort()).toEqual(Object.keys(SURFACE).sort());
    const docs = await request(t.app).get("/docs/");
    expect(docs.status).toBe(200);
    expect(docs.text).toContain("swagger");
  });
});
