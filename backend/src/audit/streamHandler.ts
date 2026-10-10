import { loadRuntimeEnv } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { isSumIdShaped } from "../crypto/sumId.js";
import { createAuditSink, newReceipt, type AuditSink, type DeletionReceipt } from "./receipts.js";

/**
 * Lambda handler for the DynamoDB Stream of `discharge-summaries` ("day 30, auto-delete -> Audit
 * log"). TTL deletions arrive as REMOVE records whose `userIdentity` is
 * `{ type: "Service", principalId: "dynamodb.amazonaws.com" }`; nothing else is a TTL deletion, so
 * nothing else is recorded. Enable the stream with StreamViewType OLD_IMAGE (or NEW_AND_OLD_IMAGES)
 * so the receipt can carry the `expiresAt` the item had. Keys are `{ uid: { S } }` (DYNAMO_PK) and a
 * summary item's uid is its sumId; receipt# and probe items are skipped. IAM: dynamodb:DescribeStream,
 * GetRecords, GetShardIterator, ListStreams on the stream, plus the sink's permissions (AUDIT_SINK=sql
 * with the RDS settings from Secrets Manager, or dynamo, file, console).
 */
export interface DynamoStreamRecord {
  eventName?: "INSERT" | "MODIFY" | "REMOVE";
  userIdentity?: { type?: string; principalId?: string };
  dynamodb?: {
    Keys?: Record<string, { S?: string }>;
    OldImage?: { expiresAt?: { N?: string }; "sum-id"?: { S?: string } };
    ApproximateCreationDateTime?: number;
  };
}

export interface DynamoStreamEvent {
  Records?: DynamoStreamRecord[];
}

export function isTtlDeletion(record: DynamoStreamRecord): boolean {
  return record.eventName === "REMOVE" && record.userIdentity?.type === "Service" && record.userIdentity?.principalId === "dynamodb.amazonaws.com";
}

export function receiptsFromStreamEvent(event: DynamoStreamEvent, now: () => Date = () => new Date(), keyAttribute = "uid"): DeletionReceipt[] {
  const out: DeletionReceipt[] = [];
  for (const r of event.Records ?? []) {
    if (!isTtlDeletion(r)) continue;
    const uid = r.dynamodb?.Keys?.[keyAttribute]?.S;
    if (!uid || !isSumIdShaped(uid)) continue; // receipt#, probe# or foreign items never look like a sumId
    const ttl = r.dynamodb?.OldImage?.expiresAt?.N;
    out.push(newReceipt({ sumId: uid, uid, deleted: "record", mechanism: "dynamodb_ttl", source: "dynamodb-stream", expiresAt: ttl ? Number(ttl) : undefined, at: now().toISOString() }));
  }
  return out;
}

let sink: AuditSink | undefined;
let keyAttribute = "uid";

export async function handler(event: DynamoStreamEvent, auditSink?: AuditSink): Promise<{ receipts: number }> {
  if (!auditSink && !sink) {
    const { env } = await loadRuntimeEnv();
    const config = loadConfig(env);
    keyAttribute = config.DYNAMO_PK;
    sink = await createAuditSink(config);
  }
  const target = auditSink ?? sink!;
  const receipts = receiptsFromStreamEvent(event, undefined, auditSink ? "uid" : keyAttribute);
  for (const r of receipts) await target.append(r);
  return { receipts: receipts.length };
}
