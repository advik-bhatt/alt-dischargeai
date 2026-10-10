import { loadRuntimeEnv } from "../bootstrap.js";
import { loadConfig } from "../config.js";
import { OBJECT_KEY_RE, objectKindFor } from "../data/objects.js";
import { createAuditSink, newReceipt, type AuditSink, type DeletionReceipt } from "./receipts.js";

/**
 * Lambda handler for S3 event notifications on the PDF and audio buckets ("day 30, lifecycle
 * expire -> Audit log"). Lifecycle expirations arrive as `s3:LifecycleExpiration:Delete` (and
 * `s3:LifecycleExpiration:DeleteMarkerCreated` on versioned buckets); object keys are
 * `<sumId>.pdf` in emrpdf-rh, `<sumId>.<ext>` in emraudio-rh and `transcripts/<job>.json` for
 * Transcribe output, so the receipt carries the sumId when the key has one and never any content.
 * IAM: the sink's permissions. Env: same as streamHandler.ts.
 */
export interface S3EventRecord {
  eventName?: string;
  eventTime?: string;
  s3?: { bucket?: { name?: string }; object?: { key?: string } };
}

export interface S3Event {
  Records?: S3EventRecord[];
}

export function isLifecycleExpiration(record: S3EventRecord): boolean {
  return /LifecycleExpiration/.test(record.eventName ?? "");
}

export function receiptsFromS3Event(event: S3Event, now: () => Date = () => new Date()): DeletionReceipt[] {
  const out: DeletionReceipt[] = [];
  for (const r of event.Records ?? []) {
    if (!isLifecycleExpiration(r)) continue;
    const key = decodeURIComponent((r.s3?.object?.key ?? "").replace(/\+/g, " "));
    if (!key) continue;
    const m = OBJECT_KEY_RE.exec(key);
    out.push(
      newReceipt({
        sumId: m ? m[1] : "-",
        deleted: objectKindFor(key) ?? (key.startsWith("transcripts/") ? "transcript" : "audio"),
        mechanism: "s3_lifecycle",
        source: "s3-event",
        key,
        at: now().toISOString(),
      }),
    );
  }
  return out;
}

let sink: AuditSink | undefined;

export async function handler(event: S3Event, auditSink?: AuditSink): Promise<{ receipts: number }> {
  if (!auditSink && !sink) {
    const { env } = await loadRuntimeEnv();
    sink = await createAuditSink(loadConfig(env));
  }
  const target = auditSink ?? sink!;
  const receipts = receiptsFromS3Event(event);
  for (const r of receipts) await target.append(r);
  return { receipts: receipts.length };
}
