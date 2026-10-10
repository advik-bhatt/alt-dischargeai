import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import type { DischargeRecord, ExpiredRecordRef, RecordStore } from "../records.js";

/**
 * SQLite twin of the DynamoDB table `discharge_records`: one row per item, same attribute names,
 * sealed fields and lists stored as JSON text. `expiresAt` is epoch seconds like the TTL attribute.
 * DynamoDB deletes expired items in the background; here `src/data/sweeper.ts` does the same job.
 */
const DDL = `
CREATE TABLE IF NOT EXISTS discharge_records (
  tokenHash TEXT PRIMARY KEY,
  createdAt TEXT NOT NULL,
  updatedAt TEXT NOT NULL,
  expiresAt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'ready', 'needs_review', 'failed')),
  statusReason TEXT,
  language TEXT NOT NULL,
  languages TEXT NOT NULL,
  inputKind TEXT NOT NULL,
  audioKey TEXT,
  keyVersion INTEGER NOT NULL,
  transcript TEXT,
  perLanguage TEXT,
  safety TEXT,
  patientLabel TEXT,
  pipeline TEXT
);
CREATE INDEX IF NOT EXISTS discharge_records_expiresAt ON discharge_records (expiresAt);
CREATE INDEX IF NOT EXISTS discharge_records_status ON discharge_records (status, createdAt);
`;

const JSON_FIELDS = new Set(["languages", "transcript", "perLanguage", "safety", "patientLabel", "pipeline"]);

interface Row {
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  expiresAt: number;
  status: DischargeRecord["status"];
  statusReason: string | null;
  language: string;
  languages: string;
  inputKind: DischargeRecord["inputKind"];
  audioKey: string | null;
  keyVersion: number;
  transcript: string | null;
  perLanguage: string | null;
  safety: string | null;
  patientLabel: string | null;
  pipeline: string | null;
}

function toRecord(r: Row): DischargeRecord {
  const parse = <T>(s: string | null): T | undefined => (s === null ? undefined : (JSON.parse(s) as T));
  return {
    tokenHash: r.tokenHash,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    expiresAt: Number(r.expiresAt),
    status: r.status,
    statusReason: r.statusReason ?? undefined,
    language: r.language,
    languages: JSON.parse(r.languages) as string[],
    inputKind: r.inputKind,
    audioKey: r.audioKey ?? undefined,
    keyVersion: Number(r.keyVersion),
    transcript: parse(r.transcript),
    perLanguage: parse(r.perLanguage),
    safety: parse(r.safety),
    patientLabel: parse(r.patientLabel),
    pipeline: parse(r.pipeline),
  };
}

function toSql(field: string, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (JSON_FIELDS.has(field)) return JSON.stringify(value);
  return value as string | number;
}

export class LocalRecordStore implements RecordStore {
  readonly name = "local" as const;
  readonly db: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(DDL);
  }

  async put(record: DischargeRecord): Promise<void> {
    const fields = ["tokenHash", "createdAt", "updatedAt", "expiresAt", "status", "statusReason", "language", "languages", "inputKind", "audioKey", "keyVersion", "transcript", "perLanguage", "safety", "patientLabel", "pipeline"] as const;
    const values = fields.map((f) => toSql(f, record[f]));
    this.db
      .prepare(`INSERT OR REPLACE INTO discharge_records (${fields.join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`)
      .run(...values);
  }

  async get(tokenHash: string): Promise<DischargeRecord | null> {
    const row = this.db.prepare("SELECT * FROM discharge_records WHERE tokenHash = ?").get(tokenHash) as Row | undefined;
    return row ? toRecord(row) : null;
  }

  async update(tokenHash: string, patch: Partial<Omit<DischargeRecord, "tokenHash">>): Promise<void> {
    const entries = Object.entries(patch).filter(([, v]) => v !== undefined);
    if (!entries.length) return;
    const sets = entries.map(([k]) => `${k} = ?`).join(", ");
    const values = entries.map(([k, v]) => toSql(k, v));
    this.db.prepare(`UPDATE discharge_records SET ${sets} WHERE tokenHash = ?`).run(...values, tokenHash);
  }

  async delete(tokenHash: string): Promise<boolean> {
    return this.db.prepare("DELETE FROM discharge_records WHERE tokenHash = ?").run(tokenHash).changes > 0;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<ExpiredRecordRef[]> {
    const rows = this.db
      .prepare("SELECT tokenHash, expiresAt, audioKey FROM discharge_records WHERE expiresAt <= ? ORDER BY expiresAt LIMIT ?")
      .all(nowEpochSeconds, limit) as { tokenHash: string; expiresAt: number; audioKey: string | null }[];
    return rows.map((r) => ({ tokenHash: r.tokenHash, expiresAt: Number(r.expiresAt), audioKey: r.audioKey ?? undefined }));
  }

  async listProcessingBefore(iso: string): Promise<string[]> {
    const rows = this.db.prepare("SELECT tokenHash FROM discharge_records WHERE status = 'processing' AND createdAt < ?").all(iso) as { tokenHash: string }[];
    return rows.map((r) => r.tokenHash);
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
