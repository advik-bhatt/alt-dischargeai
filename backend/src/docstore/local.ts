import type { AiOutput } from "../contracts/aiOutput.js";
import type { Db } from "../db/index.js";
import type { SummaryItem, SummaryPatch, SummaryStore } from "./types.js";

interface Row {
  uid: string;
  item: string;
  expires_at: number | string;
  created_at: string;
}

/** The upsert is the one statement the two engines spell differently. */
export function upsertSummarySql(dialect: Db["dialect"]): string {
  const insert = "INSERT INTO summaries (uid, item, expires_at, created_at) VALUES (?, ?, ?, ?)";
  if (dialect === "mysql") return `${insert} ON DUPLICATE KEY UPDATE item = VALUES(item), expires_at = VALUES(expires_at), created_at = VALUES(created_at)`;
  return `${insert} ON CONFLICT (uid) DO UPDATE SET item = excluded.item, expires_at = excluded.expires_at, created_at = excluded.created_at`;
}

function parse(r: Row): SummaryItem {
  const item = JSON.parse(r.item) as SummaryItem;
  return { ...item, uid: r.uid, translations: item.translations ?? {} };
}

/**
 * The SQL twin of `discharge-summaries` for local work and tests (DOC_STORE=local): one row per
 * summary with the same uid the real table uses and the whole item as JSON; the purge job plays the
 * part of TTL. Updates are read-merge-write, which the single-writer job queue makes safe here.
 */
export class LocalSummaryStore implements SummaryStore {
  readonly name = "local" as const;
  readonly describe: string;
  private readonly upsert: string;

  constructor(private readonly db: Db) {
    this.upsert = upsertSummarySql(db.dialect);
    this.describe = `${db.dialect}:summaries (twin of discharge-summaries, key=uid)`;
  }

  async put(item: SummaryItem): Promise<void> {
    await this.db.run(this.upsert, [item.uid, JSON.stringify(item), item.expiresAt, item.createdAt]);
  }

  async get(uid: string): Promise<SummaryItem | null> {
    const row = await this.db.get<Row>("SELECT * FROM summaries WHERE uid = ?", [uid]);
    return row ? parse(row) : null;
  }

  async update(uid: string, patch: SummaryPatch): Promise<void> {
    const current = await this.get(uid);
    if (!current) throw new Error(`summary ${uid} does not exist`);
    const next: SummaryItem = { ...current };
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    await this.put(next);
  }

  async setTranslation(uid: string, lang: string, output: AiOutput): Promise<void> {
    const current = await this.get(uid);
    if (!current) throw new Error(`summary ${uid} does not exist`);
    await this.put({ ...current, translations: { ...current.translations, [lang]: output } });
  }

  async delete(uid: string): Promise<boolean> {
    const r = await this.db.run("DELETE FROM summaries WHERE uid = ?", [uid]);
    return r.changes > 0;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<{ uid: string; expiresAt: number }[]> {
    const rows = await this.db.all<{ uid: string; expires_at: number | string }>("SELECT uid, expires_at FROM summaries WHERE expires_at <= ? ORDER BY expires_at LIMIT ?", [nowEpochSeconds, limit]);
    return rows.map((r) => ({ uid: r.uid, expiresAt: Number(r.expires_at) }));
  }
}
