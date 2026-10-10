import { describe, expect, it } from "vitest";
import { BACKEND_DIR, MySqlDb, parseDatabaseUrl, readCaBundle, resolveCaBundlePath, splitStatements, type Db } from "../src/db/index.js";
import { REQUIRED_TABLES, migrationFilesFor, toDialect } from "../src/db/migrate.js";
import { upsertSummarySql } from "../src/docstore/local.js";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import request from "supertest";
import { createTestApp } from "./helpers.js";
import { join } from "node:path";

const DIR = join(import.meta.dirname, "..", "src", "db", "migrations");
const MIGRATION = readFileSync(join(DIR, "0001_init.sql"), "utf8");
const PATIENTINFO_SQLITE = readFileSync(join(DIR, "0002_patientinfo.sqlite.sql"), "utf8");
const PATIENTINFO_MYSQL = readFileSync(join(DIR, "0002_patientinfo.mysql.sql"), "utf8");

describe("SQL layer: one portable schema, two dialects", () => {
  it("parses DATABASE_URL for SQLite and for MariaDB on RDS, decoding the password", () => {
    expect(parseDatabaseUrl("sqlite:data/app.db")).toEqual({ dialect: "sqlite", file: "data/app.db" });
    expect(parseDatabaseUrl("sqlite:data/live.db")).toEqual({ dialect: "sqlite", file: "data/live.db" });
    expect(parseDatabaseUrl("sqlite::memory:")).toEqual({ dialect: "sqlite", file: ":memory:" });
    const rds = parseDatabaseUrl("mysql://admin:p%40ss%21%24@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai");
    expect(rds.dialect).toBe("mysql");
    expect(rds.mysql).toEqual({ host: "patients.cleqcmkoulma.us-west-2.rds.amazonaws.com", port: 3306, user: "admin", password: "p@ss!$", database: "dischargeai", insecure: false });
    expect(parseDatabaseUrl("mariadb://u:p@localhost/x?insecure=1").mysql).toMatchObject({ port: 3306, insecure: true });
    expect(() => parseDatabaseUrl("mysql://u:p@localhost")).toThrow(/name a database/);
    expect(() => parseDatabaseUrl("postgres://u:p@localhost/x")).toThrow(/sqlite: or mysql/);
  });

  it("splits the migration into statements with comments removed; the team contract's tables are there", () => {
    const statements = splitStatements(MIGRATION);
    expect(statements.length).toBeGreaterThanOrEqual(10);
    expect(statements.every((s) => !s.includes("--"))).toBe(true);
    expect(statements.filter((s) => s.startsWith("CREATE TABLE")).map((s) => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/)![1])).toEqual([...REQUIRED_TABLES]);
    expect(REQUIRED_TABLES).toEqual(["activeLinks", "jobs", "audit_log", "summaries"]);
    expect(splitStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1; SELECT 2"]);
    expect(splitStatements("SELECT 1;\nSELECT 2;\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("activeLinks has the contract's columns and no foreign key to a patients table; the backend creates no patients table of its own", () => {
    const activeLinks = splitStatements(MIGRATION).find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS activeLinks"))!;
    for (const col of ["id INTEGER PRIMARY KEY AUTOINCREMENT", "sumId VARCHAR(32) NOT NULL", "patientID VARCHAR(64) NOT NULL", "createdAt VARCHAR(32) NOT NULL", "expiresAt VARCHAR(32) NOT NULL", "status VARCHAR(16) NOT NULL", "UNIQUE (sumId)"]) {
      expect(activeLinks, col).toContain(col);
    }
    expect(activeLinks).not.toMatch(/REFERENCES patients/);
    expect(MIGRATION).not.toMatch(/CREATE TABLE IF NOT EXISTS patients\b/);
  });

  it("0002 creates patientinfo with the tasks doc's columns only when missing, per dialect, and drops the old foreign key", () => {
    for (const sql of [PATIENTINFO_SQLITE, PATIENTINFO_MYSQL]) {
      const create = splitStatements(sql).find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS patientinfo"))!;
      for (const col of ["ID VARCHAR(64) PRIMARY KEY", "DOB", "FirstName", "LastName", "ZipCode", "email", "phoneNumber", "caregiverEmail", "caregiverName"]) expect(create, col).toContain(col);
      expect(sql).not.toMatch(/INSERT INTO patientinfo|DROP TABLE patientinfo|DELETE FROM/);
    }
    expect(splitStatements(PATIENTINFO_MYSQL)[0]).toBe("ALTER TABLE activeLinks DROP FOREIGN KEY fk_activeLinks_patient");
    expect(PATIENTINFO_SQLITE).toContain("ALTER TABLE activeLinks_rebuild RENAME TO activeLinks");
    expect(migrationFilesFor(["0002_patientinfo.mysql.sql", "0001_init.sql", "0002_patientinfo.sqlite.sql", "notes.txt"], "sqlite")).toEqual(["0001_init.sql", "0002_patientinfo.sqlite.sql"]);
    expect(migrationFilesFor(["0002_patientinfo.mysql.sql", "0001_init.sql", "0002_patientinfo.sqlite.sql"], "mysql")).toEqual(["0001_init.sql", "0002_patientinfo.mysql.sql"]);
  });

  it("rewrites the schema for MySQL/MariaDB and leaves SQLite untouched", () => {
    const mysql = toDialect(MIGRATION, "mysql");
    expect(mysql).toContain("INTEGER PRIMARY KEY AUTO_INCREMENT");
    expect(mysql).not.toMatch(/\bAUTOINCREMENT\b/);
    expect(mysql).toContain("item MEDIUMTEXT NOT NULL");
    expect(mysql).toContain("safety MEDIUMTEXT");
    expect(mysql).not.toContain("CREATE INDEX IF NOT EXISTS");
    expect(mysql).toContain("CREATE INDEX activeLinks_expiresAt ON activeLinks (expiresAt)");
    expect(mysql).not.toMatch(/\bTEXT PRIMARY KEY\b/);
    expect(toDialect(MIGRATION, "sqlite")).toBe(MIGRATION);
  });

  it("spells the summary upsert per dialect", () => {
    expect(upsertSummarySql("sqlite")).toContain("ON CONFLICT (uid) DO UPDATE SET item = excluded.item");
    expect(upsertSummarySql("mysql")).toContain("ON DUPLICATE KEY UPDATE item = VALUES(item)");
    expect(upsertSummarySql("mysql")).not.toContain("excluded");
  });

  it("the schema uses VARCHAR for every keyed column so MariaDB can index it", () => {
    for (const line of MIGRATION.split("\n")) {
      if (/PRIMARY KEY|REFERENCES/.test(line) && /^\s+\w+ /.test(line) && !/^\s+(CONSTRAINT|PRIMARY KEY)/.test(line)) expect(line, line).toMatch(/VARCHAR\(\d+\)|INTEGER/);
    }
    const _typeOnly: Db["dialect"][] = ["sqlite", "mysql"];
    expect(_typeOnly).toHaveLength(2);
  });

  it("upgrades a SQLite file migrated by the earlier 0001 (own patients table, foreign key): links kept, ingest works for a patientinfo row", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "dischargeai-upgrade-")), "old.db");
    const old = new Database(file);
    old.pragma("foreign_keys = ON");
    old.exec("CREATE TABLE schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)");
    for (const stmt of splitStatements(readFileSync(join(import.meta.dirname, "fixtures", "0001_init.before-patientinfo.sql"), "utf8"))) old.exec(stmt);
    old.exec("INSERT INTO schema_migrations VALUES ('0001_init.sql', '2026-10-10T00:00:00Z')");
    old.exec("INSERT INTO patients (id, first_name, last_name, date_of_birth, zip_code, email, phone, created_at) VALUES ('pt-0001', 'Fake', 'Seed', '1950-01-01', '1', 'fake@example.test', '1', 'x')");
    old.exec("INSERT INTO activeLinks (sumId, patientID, createdAt, expiresAt, status) VALUES ('AAAAAAAAAAAAAAAAAAAAAA', 'pt-0001', '2026-10-10T00:00:00Z', '2026-11-09T00:00:00Z', 'ready')");
    old.close();

    const app = await createTestApp({ seed: false, env: { DATABASE_FILE: file } });
    try {
      // The old link survived the rebuild; the old patients table is no longer what /patients reads.
      expect(await app.ctx.activeLinks.getBySumId("AAAAAAAAAAAAAAAAAAAAAA")).toMatchObject({ patientID: "pt-0001", status: "ready" });
      expect((await app.provider(request(app.app).get("/patients"))).body).toEqual({ patients: [] });
      await app.ctx.db.run("INSERT INTO patientinfo (ID, FirstName, LastName, DOB, ZipCode, email, phoneNumber) VALUES ('42', 'Real', 'Person', '1960-01-01', '08901', 'real@example.test', '555')");
      const res = await app.provider(request(app.app).post("/ingest")).send({ data: "New medications:\n- Furosemide 40 mg by mouth once daily", type: "text", patientID: "42" });
      expect(res.status).toBe(202);
      await app.ctx.queue.onIdle();
      expect(app.mailer.sent.map((m) => m.to)).toEqual(["real@example.test"]);
    } finally {
      await app.close();
    }
  });

  it("passes the RDS global-bundle.pem: resolved from backend/ wherever the process starts, required, and the committed copy is a real bundle", async () => {
    expect(resolveCaBundlePath("certs/global-bundle.pem")).toBe(join(BACKEND_DIR, "certs", "global-bundle.pem"));
    expect(resolveCaBundlePath("/etc/ssl/rds.pem")).toBe("/etc/ssl/rds.pem");
    const pem = readCaBundle(resolveCaBundlePath("certs/global-bundle.pem"));
    expect((pem.toString("utf8").match(/BEGIN CERTIFICATE/g) ?? []).length).toBeGreaterThan(100);
    expect(() => readCaBundle(join(BACKEND_DIR, "certs", "missing.pem"))).toThrow(/RDS CA bundle not found .*truststore\.pki\.rds\.amazonaws\.com\/global\/global-bundle\.pem/);
    // No silent fallback: a MySQL connection without the bundle stops before any network call.
    await expect(MySqlDb.connect({ host: "127.0.0.1", port: 1, user: "u", password: "p", database: "d", caBundlePath: join(BACKEND_DIR, "certs", "missing.pem") })).rejects.toThrow(/RDS CA bundle not found/);
  });
});
