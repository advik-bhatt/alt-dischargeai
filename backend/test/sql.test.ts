import { describe, expect, it } from "vitest";
import { parseDatabaseUrl, splitStatements, type Db } from "../src/db/index.js";
import { REQUIRED_TABLES, toDialect } from "../src/db/migrate.js";
import { upsertSummarySql } from "../src/docstore/local.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "src", "db", "migrations", "0001_init.sql"), "utf8");

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
    expect(REQUIRED_TABLES).toEqual(["patients", "activeLinks", "jobs", "audit_log", "summaries"]);
    expect(splitStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1; SELECT 2"]);
    expect(splitStatements("SELECT 1;\nSELECT 2;\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("activeLinks has the contract's columns (id auto, sumId, patientID, createdAt, expiresAt, status) and patients has the caregiver columns", () => {
    const activeLinks = splitStatements(MIGRATION).find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS activeLinks"))!;
    for (const col of ["id INTEGER PRIMARY KEY AUTOINCREMENT", "sumId VARCHAR(32) NOT NULL", "patientID VARCHAR(64) NOT NULL", "createdAt VARCHAR(32) NOT NULL", "expiresAt VARCHAR(32) NOT NULL", "status VARCHAR(16) NOT NULL", "UNIQUE (sumId)"]) {
      expect(activeLinks, col).toContain(col);
    }
    const patients = splitStatements(MIGRATION).find((s) => s.startsWith("CREATE TABLE IF NOT EXISTS patients"))!;
    expect(patients).toContain("caregiver_email VARCHAR(254)");
    expect(patients).toContain("caregiver_name VARCHAR(160)");
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
});
