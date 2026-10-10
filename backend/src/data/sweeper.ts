import { newReceipt, type AuditSink, type DeletionReceipt } from "../audit/receipts.js";
import { LINK_TTL_DAYS } from "../config.js";
import { hashPrefix } from "../crypto/token.js";
import type { Logger } from "../logger.js";
import type { AudioStore } from "./audio.js";
import type { RecordStore } from "./records.js";

/**
 * The local twin of two AWS background processes:
 *   1. DynamoDB TTL: delete every `discharge_records` item whose `expiresAt` <= now.
 *   2. S3 lifecycle: delete every audio object written more than 30 days ago.
 * Each deletion writes a receipt to the audit log, exactly what the Streams and S3 event handlers do
 * on AWS. `now` is injected: the app passes the real clock; scripts/sweep.ts passes DEMO_NOW so the
 * TTL proof can be shown on stage without waiting a month.
 */
export interface SweepDeps {
  records: RecordStore;
  audio: AudioStore;
  audit: AuditSink;
  log?: Logger;
  ttlDays?: number;
}

export interface SweepReport {
  now: string;
  recordsDeleted: number;
  audioDeleted: number;
  receipts: DeletionReceipt[];
}

export async function runSweep(deps: SweepDeps, now: Date = new Date()): Promise<SweepReport> {
  const report: SweepReport = { now: now.toISOString(), recordsDeleted: 0, audioDeleted: 0, receipts: [] };
  const nowEpoch = Math.floor(now.getTime() / 1000);

  for (const ref of await deps.records.listExpired(nowEpoch)) {
    if (!(await deps.records.delete(ref.tokenHash))) continue;
    const receipt = newReceipt({ tokenHash: ref.tokenHash, deleted: "record", mechanism: "local_sweeper", source: "sweeper", expiresAt: ref.expiresAt, at: now.toISOString() });
    await deps.audit.append(receipt);
    report.receipts.push(receipt);
    report.recordsDeleted += 1;
    deps.log?.info({ record: hashPrefix(ref.tokenHash), expiresAt: ref.expiresAt }, "record expired and deleted (TTL twin)");
  }

  for (const obj of await deps.audio.listExpired(now, deps.ttlDays ?? LINK_TTL_DAYS)) {
    if (!(await deps.audio.delete(obj.key))) continue;
    const receipt = newReceipt({ tokenHash: obj.key.split(".")[0], deleted: "audio", mechanism: "local_sweeper", source: "sweeper", key: obj.key, at: now.toISOString() });
    await deps.audit.append(receipt);
    report.receipts.push(receipt);
    report.audioDeleted += 1;
    deps.log?.info({ record: hashPrefix(obj.key), createdAt: obj.createdAt }, "audio object expired and deleted (lifecycle twin)");
  }

  return report;
}
