import pg from "pg";
import type { ObjectStore, StoredObject } from "../data/objects.js";
import type { Db, SqlParam } from "../db/index.js";
import type { SummaryItem, SummaryPatch, SummaryStore } from "../docstore/types.js";

/**
 * Postgres for the hosted deployment (Supabase), in place of the local runner's SQLite file: the
 * same repositories, one database for the SQL tables, the summary items and the uploaded files, so
 * a serverless instance that is replaced keeps nothing on its own disk.
 *
 * The repositories write MySQL/SQLite-flavoured SQL. Postgres needs four things changed, done here
 * for every statement: `?` placeholders become $1..$n; backtick-quoted identifiers become
 * double-quoted; the schema's mixed-case names (activeLinks, sumId, the patient columns) are quoted
 * so rows come back with the same keys the repositories read; DATABASE() becomes current_schema().
 */

/** Every mixed-case identifier in the schema below. Lower-case names need no quoting. */
const MIXED_CASE = [
  "activeLinks", "sumId", "patientID", "createdAt", "expiresAt", "pdfKey", "audioKey", "lastViewedAt", "emailedAt",
  "ID", "DOB", "FirstName", "LastName", "ZipCode", "phoneNumber", "caregiverEmail", "caregiverName", "preferredLanguage",
];
const MIXED_CASE_RE = new RegExp(`(?<!["\\w])(${MIXED_CASE.join("|")})(?!["\\w])`, "g");

export function toPostgres(sql: string): string {
  let n = 0;
  // Odd parts are single-quoted string literals and pass through untouched.
  return sql.split(/('(?:[^']|'')*')/).map((part, i) => i % 2 ? part : part
    .replace(/`([^`]+)`/g, (_m, id: string) => `"${id.replace(/"/g, '""')}"`)
    .replace(/\bDATABASE\(\)/g, "current_schema()")
    .replace(MIXED_CASE_RE, '"$1"')
    .replace(/\?/g, () => `$${++n}`)).join("");
}

/** The schema after migrations 0001-0004, plus the summary and file tables the hosted mode keeps here. */
export const HOSTED_SCHEMA = `
CREATE TABLE IF NOT EXISTS "activeLinks" (
  id BIGSERIAL PRIMARY KEY,
  "sumId" VARCHAR(64) NOT NULL UNIQUE,
  "patientID" VARCHAR(64) NOT NULL,
  "createdAt" VARCHAR(32) NOT NULL,
  "expiresAt" VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL CHECK (status IN ('pending', 'ready', 'needs_review', 'failed', 'expired', 'purged')),
  languages VARCHAR(512) NOT NULL DEFAULT '["en"]',
  "pdfKey" VARCHAR(80),
  "audioKey" VARCHAR(80),
  "lastViewedAt" VARCHAR(32),
  "emailedAt" VARCHAR(32)
);
CREATE INDEX IF NOT EXISTS "activeLinks_expiresAt" ON "activeLinks" ("expiresAt");
CREATE INDEX IF NOT EXISTS "activeLinks_patientID" ON "activeLinks" ("patientID");
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  sum_id VARCHAR(64) NOT NULL REFERENCES "activeLinks" ("sumId"),
  stage VARCHAR(16) NOT NULL,
  input_kind VARCHAR(8) NOT NULL,
  error VARCHAR(512),
  safety TEXT,
  meta TEXT,
  created_at VARCHAR(32) NOT NULL,
  updated_at VARCHAR(32) NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_sum_id ON jobs (sum_id);
CREATE INDEX IF NOT EXISTS jobs_stage ON jobs (stage);
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  event VARCHAR(40) NOT NULL,
  sum_id VARCHAR(64),
  actor VARCHAR(16) NOT NULL CHECK (actor IN ('provider', 'patient', 'system')),
  at VARCHAR(32) NOT NULL,
  details TEXT
);
CREATE INDEX IF NOT EXISTS audit_sum_id ON audit_log (sum_id);
CREATE INDEX IF NOT EXISTS audit_event ON audit_log (event);
CREATE TABLE IF NOT EXISTS patientinfo (
  "ID" VARCHAR(64) PRIMARY KEY,
  "DOB" VARCHAR(10),
  "FirstName" VARCHAR(120),
  "LastName" VARCHAR(120),
  "ZipCode" VARCHAR(16),
  email VARCHAR(254),
  "phoneNumber" VARCHAR(32),
  "caregiverEmail" VARCHAR(254),
  "caregiverName" VARCHAR(160),
  "preferredLanguage" VARCHAR(16)
);
CREATE TABLE IF NOT EXISTS hosted_summaries (uid VARCHAR(64) PRIMARY KEY, item JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS hosted_objects (kind VARCHAR(16) NOT NULL, key VARCHAR(120) NOT NULL, content_type VARCHAR(120) NOT NULL, body BYTEA NOT NULL, PRIMARY KEY (kind, key));
`;

// COUNT(*) and BIGSERIAL ids come back as int8; the repositories expect numbers.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export class PostgresDb implements Db {
  readonly describe: string;
  private constructor(private readonly pool: pg.Pool, describe: string) {
    this.describe = describe;
  }

  /** `postgres://user:password@host:port/db`. TLS is required unless the URL says sslmode=disable. */
  static async connect(url: string, poolSize = 5): Promise<PostgresDb> {
    const u = new URL(url);
    const ssl = u.searchParams.get("sslmode") === "disable" ? false : { rejectUnauthorized: false };
    u.searchParams.delete("sslmode");
    const pool = new pg.Pool({ connectionString: u.toString(), ssl, max: poolSize, connectionTimeoutMillis: 10_000, idleTimeoutMillis: 30_000 });
    pool.on("error", () => {});
    const db = new PostgresDb(pool, `postgres://${decodeURIComponent(u.username)}@${u.hostname}:${u.port || 5432}${u.pathname}`);
    await db.exec(HOSTED_SCHEMA);
    return db;
  }

  async run(sql: string, params: SqlParam[] = []) {
    const r = await this.pool.query(toPostgres(sql), params as unknown[]);
    return { changes: r.rowCount ?? 0 };
  }
  async get<T>(sql: string, params: SqlParam[] = []) {
    return (await this.pool.query(toPostgres(sql), params as unknown[])).rows[0] as T | undefined;
  }
  async all<T>(sql: string, params: SqlParam[] = []) {
    return (await this.pool.query(toPostgres(sql), params as unknown[])).rows as T[];
  }
  /** Raw statements (the schema); not rewritten. */
  async exec(sql: string) {
    await this.pool.query(sql);
  }
  async close() {
    await this.pool.end();
  }
}

export class PostgresSummaries implements SummaryStore {
  readonly name = "postgres" as const;
  readonly describe = "postgres hosted_summaries";
  constructor(private readonly db: PostgresDb) {}
  async put(item: SummaryItem) {
    await this.db.run("INSERT INTO hosted_summaries (uid, item) VALUES (?, ?::jsonb) ON CONFLICT (uid) DO UPDATE SET item = EXCLUDED.item", [item.uid, JSON.stringify(item)]);
  }
  async get(uid: string) {
    const row = await this.db.get<{ item: SummaryItem }>("SELECT item FROM hosted_summaries WHERE uid = ?", [uid]);
    return row ? row.item : null;
  }
  /** Sets top-level attributes, like DynamoDB's UpdateItem SET (jsonb || replaces top-level keys). */
  async update(uid: string, patch: SummaryPatch) {
    const fields = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
    if (!Object.keys(fields).length) return;
    const r = await this.db.run("UPDATE hosted_summaries SET item = item || ?::jsonb WHERE uid = ?", [JSON.stringify(fields), uid]);
    if (!r.changes) throw new Error("hosted summary missing");
  }
  async delete(uid: string) {
    return (await this.db.run("DELETE FROM hosted_summaries WHERE uid = ?", [uid])).changes > 0;
  }
  async listExpired(now: number, limit = 500) {
    return this.db.all<{ uid: string; expiresAt: number }>(
      "SELECT uid, (item->>'expiresAt')::bigint AS \"expiresAt\" FROM hosted_summaries WHERE (item->>'expiresAt')::bigint <= ? LIMIT ?", [now, limit]);
  }
}

export class PostgresObjects implements ObjectStore {
  readonly name = "postgres" as const;
  constructor(private readonly db: PostgresDb, private readonly kind: "pdf" | "audio") {}
  describe() {
    return `postgres hosted_objects (${this.kind})`;
  }
  async put(item: StoredObject) {
    await this.db.run(
      "INSERT INTO hosted_objects (kind, key, content_type, body) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET content_type = EXCLUDED.content_type, body = EXCLUDED.body",
      [this.kind, item.key, item.contentType ?? "application/octet-stream", item.body]);
  }
  async get(key: string) {
    const row = await this.db.get<{ content_type: string; body: Buffer }>("SELECT content_type, body FROM hosted_objects WHERE kind = ? AND key = ?", [this.kind, key]);
    return row ? { key, contentType: row.content_type, body: Buffer.from(row.body) } : null;
  }
  async delete(key: string) {
    return (await this.db.run("DELETE FROM hosted_objects WHERE kind = ? AND key = ?", [this.kind, key])).changes > 0;
  }
}
