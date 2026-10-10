import type { Db } from "../index.js";

export type LinkStatus = "pending" | "ready" | "needs_review" | "failed" | "expired" | "purged";

export interface LinkRow {
  link_id_hash: string;
  patient_id: string;
  status: LinkStatus;
  created_at: string;
  expires_at: string;
  key_version: number;
  enc_key: Buffer | Uint8Array | null;
  language: string;
  languages: string;
  audio_key: string | null;
  last_viewed_at: string | null;
  emailed_at: string | null;
}

export interface LinkRecord {
  linkIdHash: string;
  patientId: string;
  status: LinkStatus;
  createdAt: string;
  expiresAt: string;
  keyVersion: number;
  encKey: Buffer | null;
  /** The language the provider picked at ingest (BCP-47). */
  language: string;
  /** Languages the document store holds for this link, English first. */
  languages: string[];
  audioKey: string | null;
  lastViewedAt: string | null;
  emailedAt: string | null;
}

function parseLanguages(s: string | null | undefined): string[] {
  try {
    const v = JSON.parse(s ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function toRecord(r: LinkRow): LinkRecord {
  return {
    linkIdHash: r.link_id_hash,
    patientId: r.patient_id,
    status: r.status,
    createdAt: r.created_at,
    expiresAt: r.expires_at,
    keyVersion: Number(r.key_version),
    encKey: r.enc_key ? Buffer.from(r.enc_key) : null,
    language: r.language,
    languages: parseLanguages(r.languages),
    audioKey: r.audio_key,
    lastViewedAt: r.last_viewed_at,
    emailedAt: r.emailed_at,
  };
}

export class LinksRepo {
  constructor(private readonly db: Db) {}

  async create(input: {
    linkIdHash: string;
    patientId: string;
    createdAt: string;
    expiresAt: string;
    keyVersion: number;
    encKey: Buffer;
    language: string;
    languages?: string[];
    audioKey?: string | null;
  }): Promise<LinkRecord> {
    await this.db.run(
      `INSERT INTO links (link_id_hash, patient_id, status, created_at, expires_at, key_version, enc_key, language, languages, audio_key)
       VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.linkIdHash,
        input.patientId,
        input.createdAt,
        input.expiresAt,
        input.keyVersion,
        input.encKey,
        input.language,
        JSON.stringify(input.languages ?? []),
        input.audioKey ?? null,
      ],
    );
    return (await this.getByHash(input.linkIdHash))!;
  }

  async getByHash(hash: string): Promise<LinkRecord | undefined> {
    const row = await this.db.get<LinkRow>("SELECT * FROM links WHERE link_id_hash = ?", [hash]);
    return row ? toRecord(row) : undefined;
  }

  async setStatus(hash: string, status: LinkStatus): Promise<void> {
    await this.db.run("UPDATE links SET status = ? WHERE link_id_hash = ?", [status, hash]);
  }

  async setLanguages(hash: string, languages: string[]): Promise<void> {
    await this.db.run("UPDATE links SET languages = ? WHERE link_id_hash = ?", [JSON.stringify([...new Set(languages)]), hash]);
  }

  /** Records that the document store now holds this language for the link. Returns the full list. */
  async addLanguage(hash: string, language: string): Promise<string[]> {
    const current = (await this.getByHash(hash))?.languages ?? [];
    const next = [...new Set([...current, language])];
    await this.setLanguages(hash, next);
    return next;
  }

  async setAudioKey(hash: string, audioKey: string | null): Promise<void> {
    await this.db.run("UPDATE links SET audio_key = ? WHERE link_id_hash = ?", [audioKey, hash]);
  }

  async touchViewed(hash: string, at: string): Promise<void> {
    await this.db.run("UPDATE links SET last_viewed_at = ? WHERE link_id_hash = ?", [at, hash]);
  }

  async markEmailed(hash: string, at: string): Promise<void> {
    await this.db.run("UPDATE links SET emailed_at = ? WHERE link_id_hash = ?", [at, hash]);
  }

  /** Crypto-shredding: the data key is gone for good. */
  async destroyKey(hash: string): Promise<void> {
    await this.db.run("UPDATE links SET enc_key = NULL WHERE link_id_hash = ?", [hash]);
  }

  /** Links whose expiry has passed and that have not been purged yet. */
  async listExpiredUnpurged(nowIso: string): Promise<LinkRecord[]> {
    const rows = await this.db.all<LinkRow>(
      "SELECT * FROM links WHERE expires_at <= ? AND status <> 'purged' ORDER BY expires_at",
      [nowIso],
    );
    return rows.map(toRecord);
  }

  async listByPatient(patientId: string): Promise<LinkRecord[]> {
    const rows = await this.db.all<LinkRow>("SELECT * FROM links WHERE patient_id = ? ORDER BY created_at DESC", [patientId]);
    return rows.map(toRecord);
  }
}
