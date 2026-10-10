import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";
import type { AuditRepo } from "../db/repos/audit.js";

/**
 * Deletion receipts: the audit log's proof that data is gone. A receipt says WHAT was deleted (the
 * summary item, the PDF, the audio object), WHEN, BY WHICH MECHANISM (the purge job, DynamoDB TTL,
 * the S3 lifecycle rule, or the local sweeper standing in for both) and for which sumId. Never any
 * PHI: no text, no names, no language content. Receipts outlive the data; the sumId they name
 * answers 410 from the moment the item is gone.
 * Sinks: sql (the audit_log table, default), file (JSONL twin for Lambdas without a database),
 * console (CloudWatch Logs), dynamo (receipt# items in the discharge-summaries table, never expired).
 */
export type DeletedKind = "record" | "pdf" | "audio" | "transcript";
export type DeletionMechanism = "purge_job" | "dynamodb_ttl" | "s3_lifecycle" | "local_sweeper";
export type ReceiptSource = "purge" | "sweeper" | "dynamodb-stream" | "s3-event";

export interface DeletionReceipt {
  receiptId: string;
  /** "-" when the deleted object carries no sumId (a Transcribe output object). */
  sumId: string;
  deleted: DeletedKind;
  mechanism: DeletionMechanism;
  source: ReceiptSource;
  /** When the receipt was written. */
  at: string;
  /** The summary item's uid (= sumId), for record receipts. */
  uid?: string;
  /** Object key, for PDF, audio and transcript objects. */
  key?: string;
  /** The TTL value the item carried, when known (epoch seconds). */
  expiresAt?: number;
}

const PHI_LIKE = /(text|transcript|steps|medications|name|language|label)\s*[:=]/i;

export function newReceipt(input: Omit<DeletionReceipt, "receiptId" | "at"> & { at?: string }): DeletionReceipt {
  const receipt: DeletionReceipt = { receiptId: randomUUID(), at: input.at ?? new Date().toISOString(), ...input };
  if ((receipt.key && PHI_LIKE.test(receipt.key)) || (receipt.uid && PHI_LIKE.test(receipt.uid))) {
    throw new Error("refusing to write a receipt that looks like it carries content");
  }
  return receipt;
}

export interface AuditSink {
  readonly name: "sql" | "file" | "console" | "dynamo";
  append(receipt: DeletionReceipt): Promise<void>;
  /** Oldest first. Console sink returns []. */
  list(limit?: number): Promise<DeletionReceipt[]>;
  findBySumId(sumId: string): Promise<DeletionReceipt[]>;
}

/** The default: receipts are rows of audit_log with event `deletion.receipt`, next to the other events of the link. */
export class SqlAuditSink implements AuditSink {
  readonly name = "sql" as const;

  constructor(private readonly audit: AuditRepo) {}

  async append(receipt: DeletionReceipt): Promise<void> {
    const { sumId, at, ...details } = receipt;
    await this.audit.append({ event: "deletion.receipt", sumId: sumId === "-" ? null : sumId, actor: "system", at, details });
  }

  async list(limit = 1000): Promise<DeletionReceipt[]> {
    return (await this.audit.listByEvent("deletion.receipt", limit)).map((e) => ({ ...(e.details as Omit<DeletionReceipt, "sumId" | "at">), sumId: e.sumId ?? "-", at: e.at }));
  }

  async findBySumId(sumId: string): Promise<DeletionReceipt[]> {
    return (await this.audit.listForLink(sumId)).filter((e) => e.event === "deletion.receipt").map((e) => ({ ...(e.details as Omit<DeletionReceipt, "sumId" | "at">), sumId, at: e.at }));
  }
}

/** Append-only JSONL file. */
export class FileAuditSink implements AuditSink {
  readonly name = "file" as const;

  constructor(readonly file: string) {
    mkdirSync(dirname(file), { recursive: true });
  }

  async append(receipt: DeletionReceipt): Promise<void> {
    appendFileSync(this.file, JSON.stringify(receipt) + "\n");
  }

  async list(limit = 1000): Promise<DeletionReceipt[]> {
    if (!existsSync(this.file)) return [];
    const lines = readFileSync(this.file, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => JSON.parse(l) as DeletionReceipt);
  }

  async findBySumId(sumId: string): Promise<DeletionReceipt[]> {
    return (await this.list(Number.MAX_SAFE_INTEGER)).filter((r) => r.sumId === sumId);
  }
}

/** JSON lines on stdout: what a Lambda writes to CloudWatch Logs. Not queryable, so reads return nothing. */
export class ConsoleAuditSink implements AuditSink {
  readonly name = "console" as const;

  async append(receipt: DeletionReceipt): Promise<void> {
    process.stdout.write(JSON.stringify({ audit: "deletion_receipt", ...receipt }) + "\n");
  }

  async list(): Promise<DeletionReceipt[]> {
    return [];
  }

  async findBySumId(): Promise<DeletionReceipt[]> {
    return [];
  }
}

/** The app passes its AuditRepo; a Lambda handler that has no database uses file, console or dynamo. */
export async function createAuditSink(config: Config, deps: { audit?: AuditRepo } = {}): Promise<AuditSink> {
  switch (config.AUDIT_SINK) {
    case "dynamo": {
      const { DynamoAuditSink } = await import("./dynamoSink.js");
      return new DynamoAuditSink({ tableName: config.DYNAMO_TABLE, keyAttribute: config.DYNAMO_PK, region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });
    }
    case "console":
      return new ConsoleAuditSink();
    case "file":
      return new FileAuditSink(config.AUDIT_FILE);
    case "sql":
    default: {
      if (deps.audit) return new SqlAuditSink(deps.audit);
      const { openDb } = await import("../db/index.js");
      const { migrate } = await import("../db/migrate.js");
      const { AuditRepo } = await import("../db/repos/audit.js");
      const db = await openDb(config);
      await migrate(db);
      return new SqlAuditSink(new AuditRepo(db));
    }
  }
}
