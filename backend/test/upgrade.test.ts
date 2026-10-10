import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { parseDatabaseUrl, splitStatements } from "../src/db/index.js";
import { toDialect } from "../src/db/migrate.js";
import { createTestApp } from "./helpers.js";

/**
 * A database first migrated by the pre-contract backend (commit 0d5f36b): it recorded 0001_init.sql
 * and created patients (with the seeded synthetic patients), links, jobs, audit_log and documents.
 * Seen on the team's RDS on 2026-10-10: the next start failed with "Table 'dischargeai.activeLinks'
 * doesn't exist". The upgrade renames those tables to *_pre_contract (rows kept) and builds the
 * current schema; the team's patientinfo is read, never written.
 */
const PRE_CONTRACT_SQL = readFileSync(join(import.meta.dirname, "fixtures", "0001_init.pre-contract.sql"), "utf8");

const LEGACY_ROWS = [
  "INSERT INTO schema_migrations (name, applied_at) VALUES ('0001_init.sql', '2026-10-10T00:00:00Z')",
  "INSERT INTO patients (id, first_name, last_name, date_of_birth, zip_code, email, phone, created_at) VALUES ('pt-0001', 'Fake', 'Seed', '1950-01-01', '1', 'fake@example.test', '1', 'x')",
  "INSERT INTO links (link_id_hash, patient_id, status, created_at, expires_at) VALUES ('h1', 'pt-0001', 'ready', '2026-10-10T00:00:00Z', '2026-11-09T00:00:00Z')",
  "INSERT INTO jobs (id, link_id_hash, stage, input_kind, created_at, updated_at) VALUES ('j1', 'h1', 'done', 'text', 'x', 'x')",
];

const TEAM_TABLE = [
  "CREATE TABLE patientinfo (ID INTEGER PRIMARY KEY, DOB DATE, FirstName VARCHAR(100), LastName VARCHAR(100), ZipCode VARCHAR(10), email VARCHAR(200), phoneNumber VARCHAR(30), caregiverEmail VARCHAR(200), caregiverName VARCHAR(100))",
  "INSERT INTO patientinfo VALUES (1, '1958-04-12', 'Team', 'PatientOne', '08901', 'one@example.test', '732-555-0001', 'care.one@example.test', 'Care One')",
  "INSERT INTO patientinfo VALUES (2, '1971-09-30', 'Team', 'PatientTwo', '07102', 'two@example.test', '973-555-0002', NULL, NULL)",
];

const TEXT = "New medications:\n- Furosemide 40 mg by mouth once daily for swelling";

async function expectUpgraded(env: Record<string, string>, count: (sql: string) => Promise<number>) {
  const app = await createTestApp({ seed: false, env });
  try {
    // The team's two rows, nothing else; INT ids stay numbers, DATE comes back as YYYY-MM-DD.
    const list = await app.provider(request(app.app).get("/patients"));
    expect(list.body.patients.map((p: { ID: number; DOB: string }) => [p.ID, p.DOB])).toEqual([
      [1, "1958-04-12"],
      [2, "1971-09-30"],
    ]);
    // The old tables are kept under their new names with their rows.
    expect(await count("SELECT COUNT(*) AS n FROM patients_pre_contract")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM jobs_pre_contract")).toBe(1);
    // Ingest works end to end on the new schema for a numeric patientID.
    const res = await app.provider(request(app.app).post("/ingest")).send({ data: TEXT, type: "text", patientID: 1 });
    expect(res.status).toBe(202);
    await app.ctx.queue.onIdle();
    expect(app.mailer.sent.map((m) => m.to).sort()).toEqual(["care.one@example.test", "one@example.test"]);
    expect((await app.provider(request(app.app).get("/patients/1"))).body.activeLink.sumId).toBe(res.body.sumId);
    expect(await count("SELECT COUNT(*) AS n FROM patientinfo")).toBe(2);
  } finally {
    await app.close();
  }
  // A second start changes nothing.
  const again = await createTestApp({ seed: false, env });
  try {
    expect((await again.provider(request(again.app).get("/patients"))).body.patients).toHaveLength(2);
  } finally {
    await again.close();
  }
}

describe("upgrading a database made by the pre-contract backend", () => {
  it("SQLite: renames the old tables, keeps their rows, builds the current schema", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "dischargeai-precontract-")), "old.db");
    const db = new Database(file);
    db.pragma("foreign_keys = ON");
    db.exec("CREATE TABLE schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)");
    for (const s of splitStatements(PRE_CONTRACT_SQL)) db.exec(s);
    for (const s of [...LEGACY_ROWS, ...TEAM_TABLE]) db.exec(s);
    db.close();
    await expectUpgraded({ DATABASE_FILE: file }, async (sql) => {
      const d = new Database(file, { readonly: true });
      try {
        return Number((d.prepare(sql).get() as { n: number }).n);
      } finally {
        d.close();
      }
    });
    // The current jobs table got its own index (SQLite index names are database-wide).
    const d = new Database(file, { readonly: true });
    expect((d.prepare("SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = 'jobs_stage'").get() as { tbl_name: string }).tbl_name).toBe("jobs");
    d.close();
  });

  // Runs against a real MySQL/MariaDB when MYSQL_TEST_URL is set (a user who may create and drop
  // databases), e.g. MYSQL_TEST_URL='mysql://admin:pw@127.0.0.1:3306/x?insecure=1' npm test.
  it.skipIf(!process.env.MYSQL_TEST_URL)("MySQL/MariaDB: the same upgrade, including the database-wide foreign key names", async () => {
    const mysql = await import("mysql2/promise");
    const base = parseDatabaseUrl(process.env.MYSQL_TEST_URL!).mysql!;
    const dbName = `dischargeai_upgrade_${Date.now()}`;
    const admin = await mysql.createConnection({ host: base.host, port: base.port, user: base.user, password: base.password, multipleStatements: false });
    try {
      await admin.query(`CREATE DATABASE \`${dbName}\``);
      await admin.query(`USE \`${dbName}\``);
      await admin.query("CREATE TABLE schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)");
      for (const s of splitStatements(toDialect(PRE_CONTRACT_SQL, "mysql"))) await admin.query(s);
      for (const s of [...LEGACY_ROWS, ...TEAM_TABLE.map((t) => t.replace("ID INTEGER PRIMARY KEY", "ID INT AUTO_INCREMENT PRIMARY KEY"))]) await admin.query(s);
      const url = `mysql://${encodeURIComponent(base.user)}:${encodeURIComponent(base.password)}@${base.host}:${base.port}/${dbName}?insecure=1`;
      await expectUpgraded({ DATABASE_URL: url }, async (sql) => {
        const [rows] = await admin.query(sql);
        return Number((rows as { n: number }[])[0].n);
      });
    } finally {
      await admin.query(`DROP DATABASE IF EXISTS \`${dbName}\``);
      await admin.end();
    }
  });
});
