import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "../config.js";

/**
 * Lane 4: the audit log of deletion receipts. A receipt says WHAT was deleted (record, audio object
 * or transcript object), WHEN, BY WHICH MECHANISM (DynamoDB TTL, S3 lifecycle, or the local
 * sweeper standing in for both) and for which tokenHash. Never any PHI: no text, no names, no
 * language content, no raw token. Receipts outlive the record, which is how GET /p/:token can
 * answer 410 (expired and deleted) instead of 404 after the data is gone.
 */
export type DeletedKind = "record" | "audio" | "transcript";
export type DeletionMechanism = "dynamodb_ttl" | "s3_lifecycle" | "local_sweeper";

export interface DeletionReceipt {
  receiptId: string;
  /** "-" when the deleted object carries no token (a Transcribe output object). */
  tokenHash: string;
  deleted: DeletedKind;
  mechanism: DeletionMechanism;
  /** When the receipt was written. */
  at: string;
  /** The TTL value the item carried, when known. */
  expiresAt?: number;
  /** Object key, for audio and transcript objects (tokenHash plus extension, or transcripts/<job>.json). */
  key?: string;
  /** What produced the receipt. */
  source: "dynamodb-stream" | "s3-event" | "sweeper";
}

const PHI_LIKE = /(text|transcript|steps|medications|name|language|label)\s*[:=]/i;

export function newReceipt(input: Omit<DeletionReceipt, "receiptId" | "at"> & { at?: string }): DeletionReceipt {
  const receipt: DeletionReceipt = { receiptId: randomUUID(), at: input.at ?? new Date().toISOString(), ...input };
  if (receipt.key && PHI_LIKE.test(receipt.key)) throw new Error("refusing to write a receipt that looks like it carries content");
  return receipt;
}

export interface AuditSink {
  readonly name: "file" | "console" | "dynamo";
  append(receipt: DeletionReceipt): Promise<void>;
  /** Newest last. Console sink returns []. */
  list(limit?: number): Promise<DeletionReceipt[]>;
  findByTokenHash(tokenHash: string): Promise<DeletionReceipt[]>;
}

/** Append-only JSONL file, the local twin of the audit table. */
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

  async findByTokenHash(tokenHash: string): Promise<DeletionReceipt[]> {
    return (await this.list(Number.MAX_SAFE_INTEGER)).filter((r) => r.tokenHash === tokenHash);
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

  async findByTokenHash(): Promise<DeletionReceipt[]> {
    return [];
  }
}

export async function createAuditSink(config: Config): Promise<AuditSink> {
  switch (config.AUDIT_SINK) {
    case "dynamo": {
      const { DynamoAuditSink } = await import("./dynamoSink.js");
      return new DynamoAuditSink({ tableName: config.AUDIT_TABLE, region: config.AWS_REGION, endpoint: config.DYNAMO_ENDPOINT });
    }
    case "console":
      return new ConsoleAuditSink();
    case "file":
    default:
      return new FileAuditSink(config.AUDIT_FILE);
  }
}
