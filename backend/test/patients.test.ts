import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index.js";
import type { AuditRepo } from "../src/db/repos/audit.js";
import { CONTRACT_PATIENT_KEYS, PatientsRepo, mapColumns } from "../src/db/repos/patients.js";
import { seedPatients } from "../src/db/seed.js";
import { createTestApp, exampleText, type TestApp } from "./helpers.js";

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

  it("has no POST /patients: the patients table is the team's and this backend only reads it", async () => {
    const res = await t.provider(request(t.app).post("/patients")).send({ FirstName: "X" });
    expect(res.status).toBe(404);
  });

  it("requires the provider key", async () => {
    const res = await request(t.app).get("/patients");
    expect(res.status).toBe(401);
    const wrong = await request(t.app).get("/patients").set("x-provider-key", "wrong");
    expect(wrong.status).toBe(401);
  });
});

describe("The team's patients table (patientinfo): read as it is, never seeded by the server", () => {
  const tmp = mkdtempSync(join(tmpdir(), "dischargeai-patientinfo-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** A SQLite file whose patients table was made by someone else, before the backend ever ran. */
  function teamDb(name: string, ddl: string, rows: string[]): string {
    const file = join(tmp, `${name}.db`);
    const db = new Database(file);
    db.exec(ddl);
    for (const r of rows) db.exec(r);
    db.close();
    return file;
  }

  it("the server does not seed: a fresh database has an empty patients table", async () => {
    const app = await createTestApp({ seed: false });
    try {
      const res = await app.provider(request(app.app).get("/patients"));
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ patients: [] });
    } finally {
      await app.close();
    }
  });

  it("serves exactly the rows of the team's table, mapping its own column names and INT ids to the nine keys", async () => {
    const file = teamDb(
      "snake",
      "CREATE TABLE patientinfo (patient_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT, dob TEXT, zip TEXT, Email TEXT, phone_number TEXT, caregiver_email TEXT, caregiver_name TEXT)",
      [
        "INSERT INTO patientinfo VALUES (1, 'Ana', 'Lopez', '1950-01-02', '08901', 'ana@example.test', '555-0001', 'cg@example.test', 'Carl Lopez')",
        "INSERT INTO patientinfo VALUES (2, 'Ben', 'Adams', '1960-03-04', '07102', 'ben@example.test', '555-0002', NULL, NULL)",
      ],
    );
    const app = await createTestApp({ seed: false, env: { DATABASE_FILE: file } });
    try {
      const res = await app.provider(request(app.app).get("/patients"));
      expect(res.body.patients).toEqual([
        { ID: 2, DOB: "1960-03-04", FirstName: "Ben", LastName: "Adams", ZipCode: "07102", email: "ben@example.test", phoneNumber: "555-0002", caregiverEmail: null, caregiverName: null },
        { ID: 1, DOB: "1950-01-02", FirstName: "Ana", LastName: "Lopez", ZipCode: "08901", email: "ana@example.test", phoneNumber: "555-0001", caregiverEmail: "cg@example.test", caregiverName: "Carl Lopez" },
      ]);
      expect((await app.provider(request(app.app).get("/patients/1"))).body).toMatchObject({ ID: 1, FirstName: "Ana", activeLink: null });

      // A numeric patientID from the frontend ingests for that row and emails its two addresses.
      const ingest = await app.provider(request(app.app).post("/ingest")).send({ data: exampleText("example-1-chf"), type: "text", patientID: 1 });
      expect(ingest.status).toBe(202);
      await app.ctx.queue.onIdle();
      expect(app.mailer.sent.map((m) => m.to).sort()).toEqual(["ana@example.test", "cg@example.test"]);
      expect((await app.provider(request(app.app).get("/patients/1"))).body.activeLink.sumId).toBe(ingest.body.sumId);
      // Still the team's two rows: nothing was added to their table.
      expect((await app.provider(request(app.app).get("/patients"))).body.patients).toHaveLength(2);
    } finally {
      await app.close();
    }
  });

  it("reads the real team table: id column `uid`, camelCase names, and no caregiverName column at all", async () => {
    // The columns reported by the team's RDS on 2026-10-10, in that order.
    const file = teamDb(
      "team-real",
      "CREATE TABLE patientinfo (uid VARCHAR(36) PRIMARY KEY, firstName VARCHAR(100), lastName VARCHAR(100), DOB DATE, zipCode VARCHAR(10), phoneNumber VARCHAR(30), email VARCHAR(200), caregiverEmail VARCHAR(200))",
      [
        "INSERT INTO patientinfo VALUES ('3f9c1a52-0000-4000-8000-000000000001', 'Ana', 'Lopez', '1950-01-02', '08901', '555-0001', 'ana@example.test', 'cg@example.test')",
        "INSERT INTO patientinfo VALUES ('3f9c1a52-0000-4000-8000-000000000002', 'Ben', 'Adams', '1960-03-04', '07102', '555-0002', 'ben@example.test', NULL)",
      ],
    );
    const app = await createTestApp({ seed: false, env: { DATABASE_FILE: file } });
    try {
      const res = await app.provider(request(app.app).get("/patients"));
      expect(res.status).toBe(200);
      for (const p of res.body.patients) expect(Object.keys(p)).toEqual([...CONTRACT_PATIENT_KEYS]);
      expect(res.body.patients).toEqual([
        { ID: "3f9c1a52-0000-4000-8000-000000000002", DOB: "1960-03-04", FirstName: "Ben", LastName: "Adams", ZipCode: "07102", email: "ben@example.test", phoneNumber: "555-0002", caregiverEmail: null, caregiverName: null },
        { ID: "3f9c1a52-0000-4000-8000-000000000001", DOB: "1950-01-02", FirstName: "Ana", LastName: "Lopez", ZipCode: "08901", email: "ana@example.test", phoneNumber: "555-0001", caregiverEmail: "cg@example.test", caregiverName: null },
      ]);
      expect((await app.provider(request(app.app).get("/patients/3f9c1a52-0000-4000-8000-000000000001"))).body).toMatchObject({ ID: "3f9c1a52-0000-4000-8000-000000000001", FirstName: "Ana" });
      const ingest = await app.provider(request(app.app).post("/ingest")).send({ data: exampleText("example-1-chf"), type: "text", patientID: "3f9c1a52-0000-4000-8000-000000000001" });
      expect(ingest.status).toBe(202);
      await app.ctx.queue.onIdle();
      expect(app.mailer.sent.map((m) => m.to).sort()).toEqual(["ana@example.test", "cg@example.test"]);
    } finally {
      await app.close();
    }
  });

  it("PATIENTS_TABLE reads another table; a table without an id column stops startup with its real columns", async () => {
    const other = teamDb("other", "CREATE TABLE people (ID TEXT PRIMARY KEY, FirstName TEXT, LastName TEXT, DOB TEXT, ZipCode TEXT, email TEXT, phoneNumber TEXT, caregiverEmail TEXT, caregiverName TEXT)", [
      "INSERT INTO people VALUES ('p1', 'Cy', 'Diaz', '1970-05-06', '08540', 'cy@example.test', '555-0003', NULL, NULL)",
    ]);
    const app = await createTestApp({ seed: false, env: { DATABASE_FILE: other, PATIENTS_TABLE: "people" } });
    try {
      expect((await app.provider(request(app.app).get("/patients"))).body.patients.map((p: { ID: string }) => p.ID)).toEqual(["p1"]);
    } finally {
      await app.close();
    }
    const noId = teamDb("noid", "CREATE TABLE patientinfo (FirstName TEXT, LastName TEXT)", []);
    await expect(createTestApp({ seed: false, env: { DATABASE_FILE: noId } })).rejects.toThrow(/no id column .*Its columns: FirstName, LastName/);
  });

  it("maps the tasks doc's spellings and common variants; seeding refuses MySQL", async () => {
    expect(mapColumns(["ID", "DOB", "FirstName", "LastName", "ZipCode", "email", "phoneNumber", "caregiverEmail", "caregiverName"])).toEqual({
      id: "ID", dateOfBirth: "DOB", firstName: "FirstName", lastName: "LastName", zipCode: "ZipCode", email: "email", phone: "phoneNumber", caregiverEmail: "caregiverEmail", caregiverName: "caregiverName",
    });
    expect(mapColumns(["patientID", "date_of_birth", "first_name", "last_name", "zip_code", "email_address", "phone", "caregiver_email", "caregiver_name", "preferred_language"])).toMatchObject({ id: "patientID", dateOfBirth: "date_of_birth", phone: "phone", preferredLanguage: "preferred_language" });
    expect(mapColumns(["uid", "firstName", "lastName", "DOB", "zipCode", "phoneNumber", "email", "caregiverEmail"])).toEqual({
      id: "uid", dateOfBirth: "DOB", firstName: "firstName", lastName: "lastName", zipCode: "zipCode", email: "email", phone: "phoneNumber", caregiverEmail: "caregiverEmail",
    });
    expect(mapColumns(["uid", "ID"]).id).toBe("ID");
    const mysqlRepo = new PatientsRepo({ dialect: "mysql", describe: "mysql://admin@rds/dischargeai" } as unknown as Db);
    await expect(seedPatients(mysqlRepo, { append: async () => undefined } as unknown as AuditRepo, () => "now")).rejects.toThrow(/Refusing to seed synthetic patients into MySQL/);
    await expect(mysqlRepo.insertLocal({ id: "x", firstName: "a", lastName: "b", dateOfBirth: "2000-01-01", zipCode: "1", email: "e@example.test", phone: "1" })).rejects.toThrow(/Refusing to write synthetic patients/);
  });
});
