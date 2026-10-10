import type { Db } from "../db/index.js";
import type { DocItem, DocumentStore } from "./types.js";

interface Row {
  pk: string;
  sk: string;
  ciphertext: Buffer | Uint8Array;
  iv: Buffer | Uint8Array;
  tag: Buffer | Uint8Array;
  key_version: number;
  expires_at: number | string;
  created_at: string;
}

function toItem(r: Row): DocItem {
  return {
    pk: r.pk,
    sk: r.sk,
    ciphertext: Buffer.from(r.ciphertext),
    iv: Buffer.from(r.iv),
    tag: Buffer.from(r.tag),
    keyVersion: Number(r.key_version),
    expiresAt: Number(r.expires_at),
    createdAt: r.created_at,
  };
}

/** The upsert is the one statement the two engines spell differently. */
export function upsertDocumentSql(dialect: Db["dialect"]): string {
  const insert = "INSERT INTO documents (pk, sk, ciphertext, iv, tag, key_version, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  if (dialect === "mysql") {
    return `${insert} ON DUPLICATE KEY UPDATE ciphertext = VALUES(ciphertext), iv = VALUES(iv), tag = VALUES(tag), key_version = VALUES(key_version), expires_at = VALUES(expires_at), created_at = VALUES(created_at)`;
  }
  return `${insert} ON CONFLICT (pk, sk) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, key_version = excluded.key_version, expires_at = excluded.expires_at, created_at = excluded.created_at`;
}

/** The SQL twin of the DynamoDB table (SQLite locally, the same table on MariaDB). Same item shape, same semantics. */
export class LocalDocumentStore implements DocumentStore {
  readonly name = "local" as const;
  private readonly upsert: string;

  constructor(private readonly db: Db) {
    this.upsert = upsertDocumentSql(db.dialect);
  }

  async put(item: DocItem): Promise<void> {
    await this.db.run(this.upsert, [item.pk, item.sk, item.ciphertext, item.iv, item.tag, item.keyVersion, item.expiresAt, item.createdAt]);
  }

  async get(pk: string, sk: string): Promise<DocItem | null> {
    const row = await this.db.get<Row>("SELECT * FROM documents WHERE pk = ? AND sk = ?", [pk, sk]);
    return row ? toItem(row) : null;
  }

  async list(pk: string, skPrefix?: string): Promise<DocItem[]> {
    const rows = skPrefix
      ? await this.db.all<Row>("SELECT * FROM documents WHERE pk = ? AND sk LIKE ? ORDER BY sk", [pk, `${skPrefix}%`])
      : await this.db.all<Row>("SELECT * FROM documents WHERE pk = ? ORDER BY sk", [pk]);
    return rows.map(toItem);
  }

  async deleteAll(pk: string): Promise<number> {
    const r = await this.db.run("DELETE FROM documents WHERE pk = ?", [pk]);
    return r.changes;
  }

  async listExpired(nowEpochSeconds: number, limit = 500): Promise<Pick<DocItem, "pk" | "sk">[]> {
    return this.db.all<{ pk: string; sk: string }>("SELECT pk, sk FROM documents WHERE expires_at <= ? ORDER BY expires_at LIMIT ?", [nowEpochSeconds, limit]);
  }

  async delete(pk: string, sk: string): Promise<void> {
    await this.db.run("DELETE FROM documents WHERE pk = ? AND sk = ?", [pk, sk]);
  }
}
