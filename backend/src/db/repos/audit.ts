import type { Db } from "../index.js";

export type AuditActor = "provider" | "patient" | "system";

export type AuditEvent =
  | "patient.created"
  | "link.created"
  | "job.stage"
  | "email.sent"
  | "email.queued"
  | "email.skipped"
  | "summary.viewed"
  | "translation.created"
  | "translation.viewed"
  | "synthesize.run"
  | "link.expired"
  | "link.purged"
  | "key.destroyed"
  | "purge.run"
  | "deletion.receipt";

export interface AuditRow {
  id: number;
  event: AuditEvent;
  link_id_hash: string | null;
  actor: AuditActor;
  at: string;
  details: string | null;
}

export interface AuditEntry {
  id: number;
  event: AuditEvent;
  linkIdHash: string | null;
  actor: AuditActor;
  at: string;
  details: Record<string, unknown>;
}

/** Keys that must never land in audit details. The repo strips them defensively. */
const PHI_KEYS = new Set(["text", "summary", "steps", "medications", "email", "to", "firstName", "lastName", "name", "link", "linkId", "token", "body", "output", "transcript"]);

function scrub(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (PHI_KEYS.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function toEntry(r: AuditRow): AuditEntry {
  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(r.details ?? "{}") as Record<string, unknown>;
  } catch {
    details = {};
  }
  return { id: Number(r.id), event: r.event, linkIdHash: r.link_id_hash, actor: r.actor, at: r.at, details };
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  async append(input: { event: AuditEvent; linkIdHash?: string | null; actor: AuditActor; at: string; details?: Record<string, unknown> }): Promise<void> {
    await this.db.run("INSERT INTO audit_log (event, link_id_hash, actor, at, details) VALUES (?, ?, ?, ?, ?)", [
      input.event,
      input.linkIdHash ?? null,
      input.actor,
      input.at,
      JSON.stringify(scrub(input.details ?? {})),
    ]);
  }

  async listForLink(linkIdHash: string): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>("SELECT * FROM audit_log WHERE link_id_hash = ? ORDER BY id", [linkIdHash]);
    return rows.map(toEntry);
  }

  async listByEvent(event: AuditEvent, limit = 1000): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>("SELECT * FROM audit_log WHERE event = ? ORDER BY id DESC LIMIT ?", [event, limit]);
    return rows.map(toEntry).reverse();
  }

  async listRecent(limit = 200): Promise<AuditEntry[]> {
    const rows = await this.db.all<AuditRow>("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", [limit]);
    return rows.map(toEntry).reverse();
  }
}
