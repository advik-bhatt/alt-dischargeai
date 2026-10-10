import { describe, expect, it } from "vitest";
import { parseDatabaseUrl, splitStatements, type Db } from "../src/db/index.js";
import { toDialect } from "../src/db/migrate.js";
import { upsertDocumentSql } from "../src/docstore/local.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION = readFileSync(join(import.meta.dirname, "..", "src", "db", "migrations", "0001_init.sql"), "utf8");

describe("SQL layer: one portable schema, two dialects", () => {
  it("parses DATABASE_URL for SQLite and for MariaDB on RDS, decoding the password", () => {
    expect(parseDatabaseUrl("sqlite:data/app.db")).toEqual({ dialect: "sqlite", file: "data/app.db" });
    expect(parseDatabaseUrl("sqlite::memory:")).toEqual({ dialect: "sqlite", file: ":memory:" });
    const rds = parseDatabaseUrl("mysql://admin:p%40ss%21%24@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai");
    expect(rds.dialect).toBe("mysql");
    expect(rds.mysql).toEqual({ host: "patients.cleqcmkoulma.us-west-2.rds.amazonaws.com", port: 3306, user: "admin", password: "p@ss!$", database: "dischargeai", insecure: false });
    expect(parseDatabaseUrl("mariadb://u:p@localhost/x?insecure=1").mysql).toMatchObject({ port: 3306, insecure: true });
    expect(() => parseDatabaseUrl("mysql://u:p@localhost")).toThrow(/name a database/);
    expect(() => parseDatabaseUrl("postgres://u:p@localhost/x")).toThrow(/sqlite: or mysql/);
  });

  it("splits the migration into statements with comments removed", () => {
    const statements = splitStatements(MIGRATION);
    expect(statements.length).toBeGreaterThanOrEqual(10);
    expect(statements.every((s) => !s.includes("--"))).toBe(true);
    expect(statements.filter((s) => s.startsWith("CREATE TABLE")).map((s) => s.match(/CREATE TABLE IF NOT EXISTS (\w+)/)![1])).toEqual(["patients", "links", "jobs", "audit_log", "documents"]);
    expect(splitStatements("SELECT 1; SELECT 2")).toEqual(["SELECT 1; SELECT 2"]);
    expect(splitStatements("SELECT 1;\nSELECT 2;\n")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("rewrites the schema for MySQL/MariaDB and leaves SQLite untouched", () => {
    const mysql = toDialect(MIGRATION, "mysql");
    expect(mysql).toContain("INTEGER PRIMARY KEY AUTO_INCREMENT");
    expect(mysql).not.toMatch(/\bAUTOINCREMENT\b/);
    expect(mysql).toContain("enc_key LONGBLOB");
    expect(mysql).toContain("ciphertext LONGBLOB NOT NULL");
    expect(mysql).toContain("safety MEDIUMTEXT");
    expect(mysql).not.toContain("CREATE INDEX IF NOT EXISTS");
    expect(mysql).toContain("CREATE INDEX links_expires_at ON links (expires_at)");
    expect(mysql).not.toMatch(/\bTEXT PRIMARY KEY\b/);
    expect(toDialect(MIGRATION, "sqlite")).toBe(MIGRATION);
  });

  it("spells the document upsert per dialect", () => {
    expect(upsertDocumentSql("sqlite")).toContain("ON CONFLICT (uid) DO UPDATE SET ciphertext = excluded.ciphertext");
    expect(upsertDocumentSql("mysql")).toContain("ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext)");
    expect(upsertDocumentSql("mysql")).not.toContain("excluded");
  });

  it("the schema uses VARCHAR for every keyed column so MariaDB can index it", () => {
    for (const line of MIGRATION.split("\n")) {
      if (/PRIMARY KEY|REFERENCES/.test(line) && /^\s+\w+ /.test(line) && !/^\s+(CONSTRAINT|PRIMARY KEY)/.test(line)) expect(line, line).toMatch(/VARCHAR\(\d+\)|INTEGER/);
    }
    const _typeOnly: Db["dialect"][] = ["sqlite", "mysql"];
    expect(_typeOnly).toHaveLength(2);
  });
});
