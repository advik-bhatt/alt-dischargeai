import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTRACT_PATIENT_KEYS } from "../src/db/repos/patients.js";
import { createTestApp, type TestApp } from "./helpers.js";

describe("GET /patients (team contract: ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName)", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("lists the six seeded synthetic patients with exactly the nine contract keys", async () => {
    const res = await t.provider(request(t.app).get("/patients"));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["patients"]);
    expect(res.body.patients).toHaveLength(6);
    for (const p of res.body.patients) expect(Object.keys(p)).toEqual([...CONTRACT_PATIENT_KEYS]);
    expect(res.body.patients.find((p: { ID: string }) => p.ID === "pt-0001")).toEqual({
      ID: "pt-0001",
      DOB: "1954-03-18",
      FirstName: "Harold",
      LastName: "Jennings",
      ZipCode: "08901",
      email: "harold.jennings@example.test",
      phoneNumber: "+1-732-555-0101",
      caregiverEmail: "june.jennings@example.test",
      caregiverName: "June Jennings",
    });
    expect(res.body.patients.find((p: { ID: string }) => p.ID === "pt-0004")).toMatchObject({ caregiverEmail: null, caregiverName: null });
    expect(res.body.patients.every((p: { email: string }) => p.email.endsWith("@example.test"))).toBe(true);
  });

  it("searches by name, email and phone, case-insensitively", async () => {
    const byName = await t.provider(request(t.app).get("/patients?q=reyes"));
    expect(byName.body.patients.map((p: { LastName: string }) => p.LastName)).toEqual(["Reyes"]);
    const byEmail = await t.provider(request(t.app).get("/patients?q=WEI.ZHANG"));
    expect(byEmail.body.patients).toHaveLength(1);
    const byPhone = await t.provider(request(t.app).get("/patients?q=555-0103"));
    expect(byPhone.body.patients[0].FirstName).toBe("Eleanor");
    const fullName = await t.provider(request(t.app).get("/patients?q=harold jennings"));
    expect(fullName.body.patients).toHaveLength(1);
    const none = await t.provider(request(t.app).get("/patients?q=nobody"));
    expect(none.body.patients).toHaveLength(0);
  });

  it("GET /patients/:id returns the contract keys plus the active link (null before any ingest)", async () => {
    const res = await t.provider(request(t.app).get("/patients/pt-0002"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ID: "pt-0002", FirstName: "Marisol", caregiverName: "Diego Reyes", preferredLanguage: "es", activeLink: null });
    const missing = await t.provider(request(t.app).get("/patients/nope"));
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ statusCode: 404, error: "patient_not_found" });
  });

  it("creates a patient from the camelCase body or the contract spellings and returns 201 with the nine keys", async () => {
    const res = await t.provider(request(t.app).post("/patients")).send({
      firstName: "Test",
      lastName: "Person",
      dateOfBirth: "1980-01-01",
      zipCode: "08901",
      email: "test.person@example.test",
      phone: "+1-732-555-0199",
      caregiverEmail: "care.person@example.test",
      caregiverName: "Care Person",
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body)).toEqual([...CONTRACT_PATIENT_KEYS]);
    expect(res.body.ID).toBeTruthy();
    expect(res.body.caregiverEmail).toBe("care.person@example.test");

    const contractShaped = await t.provider(request(t.app).post("/patients")).send({
      FirstName: "Second",
      LastName: "Person",
      DOB: "1981-02-02",
      ZipCode: "07102",
      email: "second.person@example.test",
      phoneNumber: "+1-973-555-0198",
      caregiverEmail: "",
      caregiverName: "",
    });
    expect(contractShaped.status).toBe(201);
    expect(contractShaped.body).toMatchObject({ FirstName: "Second", DOB: "1981-02-02", phoneNumber: "+1-973-555-0198", caregiverEmail: null, caregiverName: null });

    const list = await t.provider(request(t.app).get("/patients"));
    expect(list.body.patients).toHaveLength(8);
  });

  it("rejects an invalid body with 400, statusCode, a message and zod issues", async () => {
    const res = await t.provider(request(t.app).post("/patients")).send({ firstName: "", email: "nope" });
    expect(res.status).toBe(400);
    expect(res.body.statusCode).toBe(400);
    expect(res.body.error).toBe("validation_error");
    expect(typeof res.body.message).toBe("string");
    expect(Array.isArray(res.body.issues)).toBe(true);
  });

  it("requires the provider key", async () => {
    const res = await request(t.app).get("/patients");
    expect(res.status).toBe(401);
    const wrong = await request(t.app).get("/patients").set("x-provider-key", "wrong");
    expect(wrong.status).toBe(401);
  });
});
