import { loadConfig } from "../config.js";
import { loadDotEnv } from "../dotenv.js";
import { createAuditSink, newReceipt, type AuditSink, type DeletionReceipt } from "./receipts.js";

/**
 * Lambda handler for the DynamoDB Stream of `discharge_records` ("day 30, auto-delete -> Audit log").
 * TTL deletions arrive as REMOVE records whose `userIdentity` is
 * `{ type: "Service", principalId: "dynamodb.amazonaws.com" }`; nothing else is a TTL deletion, so
 * nothing else is recorded. Enable the stream with StreamViewType OLD_IMAGE (or NEW_AND_OLD_IMAGES)
 * so the receipt can carry the `expiresAt` the item had.
 * IAM: dynamodb:DescribeStream, GetRecords, GetShardIterator, ListStreams on the stream, plus the
 * audit sink's permissions. Env: AUDIT_SINK=dynamo AUDIT_TABLE=discharge_audit (or console for CloudWatch only).
 */
export interface DynamoStreamRecord {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  userIdentity?: { type?: string; principalId?: string };
  dynamodb?: {
    Keys?: { tokenHash?: { S?: string } };
    OldImage?: { expiresAt?: { N?: string }; audioKey?: { S?: string } };
    ApproximateCreationDateTime?: number;
  };
}

export interface DynamoStreamEvent {
  Records?: DynamoStreamRecord[];
}

export function isTtlDeletion(record: DynamoStreamRecord): boolean {
  return record.eventName === "REMOVE" && record.userIdentity?.type === "Service" && record.userIdentity?.principalId === "dynamodb.amazonaws.com";
}

export function receiptsFromStreamEvent(event: DynamoStreamEvent, now: () => Date = () => new Date()): DeletionReceipt[] {
  const out: DeletionReceipt[] = [];
  for (const r of event.Records ?? []) {
    if (!isTtlDeletion(r)) continue;
    const tokenHash = r.dynamodb?.Keys?.tokenHash?.S;
    if (!tokenHash) continue;
    const ttl = r.dynamodb?.OldImage?.expiresAt?.N;
    out.push(
      newReceipt({
        tokenHash,
        deleted: "record",
        mechanism: "dynamodb_ttl",
        source: "dynamodb-stream",
        expiresAt: ttl ? Number(ttl) : undefined,
        at: now().toISOString(),
      }),
    );
  }
  return out;
}

let sink: AuditSink | undefined;

export async function handler(event: DynamoStreamEvent, auditSink?: AuditSink): Promise<{ receipts: number }> {
  if (!auditSink && !sink) {
    loadDotEnv();
    sink = await createAuditSink(loadConfig());
  }
  const target = auditSink ?? sink!;
  const receipts = receiptsFromStreamEvent(event);
  for (const r of receipts) await target.append(r);
  return { receipts: receipts.length };
}
