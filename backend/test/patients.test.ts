import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "./helpers.js";

describe("patients", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("lists the six seeded synthetic patients", async () => {
    const res = await t.provider(request(t.app).get("/patients"));
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(6);
    expect(res.body.patients[0]).toMatchObject({ activeLinkId: null, activeLinkExpiresAt: null });
    expect(res.body.patients.every((p: { email: string }) => p.email.endsWith("@example.test"))).toBe(true);
  });

  it("searches by name, email and phone, case-insensitively", async () => {
    const byName = await t.provider(request(t.app).get("/patients?q=reyes"));
    expect(byName.body.patients.map((p: { lastName: string }) => p.lastName)).toEqual(["Reyes"]);
    const byEmail = await t.provider(request(t.app).get("/patients?q=WEI.ZHANG"));
    expect(byEmail.body.count).toBe(1);
    const byPhone = await t.provider(request(t.app).get("/patients?q=555-0103"));
    expect(byPhone.body.patients[0].firstName).toBe("Eleanor");
    const none = await t.provider(request(t.app).get("/patients?q=nobody"));
    expect(none.body.count).toBe(0);
  });

  it("creates a patient and returns 201", async () => {
    const res = await t.provider(request(t.app).post("/patients")).send({
      firstName: "Test",
      lastName: "Person",
      dateOfBirth: "1980-01-01",
      zipCode: "08901",
      email: "test.person@example.test",
      phone: "+1-732-555-0199",
    });
    expect(res.status).toBe(201);
    expect(res.body.id).toBeTruthy();
    const list = await t.provider(request(t.app).get("/patients"));
    expect(list.body.count).toBe(7);
  });

  it("rejects an invalid body with 400 and zod issues", async () => {
    const res = await t.provider(request(t.app).post("/patients")).send({ firstName: "", email: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("requires the provider key", async () => {
    const res = await request(t.app).get("/patients");
    expect(res.status).toBe(401);
    const wrong = await request(t.app).get("/patients").set("x-provider-key", "wrong");
    expect(wrong.status).toBe(401);
  });
});
