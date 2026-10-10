import { newReceipt, type DeletionReceipt } from "../audit/receipts.js";
import type { AppContext } from "../context.js";
import { logRef } from "../crypto/sumId.js";
import { objectKindFor } from "../data/objects.js";

export interface PurgeReport {
  ranAt: string;
  linksPurged: number;
  documentsDeleted: number;
  pdfsDeleted: number;
  audioDeleted: number;
  orphanDocumentsDeleted: number;
  orphanObjectsDeleted: number;
  purged: { linkRef: string; expiresAt: string; documentDeleted: boolean; pdfDeleted: boolean; audioDeleted: boolean }[];
  receipts: DeletionReceipt[];
}

/**
 * The 30-day self-destruct, in code. For every link past its expiry:
 *   1. delete the summary item (raw text, LLM summary, translations) from the document store,
 *   2. delete the PDF and the audio object from their buckets, one deletion receipt each,
 *   3. mark the link purged,
 *   4. write audit events.
 * Then the backstops, the local twins of DynamoDB TTL and the S3 lifecycle rules: any item or
 * object past 30 days that the loop above did not reach is deleted with a receipt.
 * Read paths check expiry on their own, so a purge that has not run yet never exposes data.
 */
export async function runPurge(ctx: AppContext): Promise<PurgeReport> {
  const { activeLinks, audit, summaries, pdf, audio, receipts, clock, log } = ctx;
  const ranAt = clock.nowIso();
  const report: PurgeReport = { ranAt, linksPurged: 0, documentsDeleted: 0, pdfsDeleted: 0, audioDeleted: 0, orphanDocumentsDeleted: 0, orphanObjectsDeleted: 0, purged: [], receipts: [] };
  const record = async (receipt: DeletionReceipt) => {
    await receipts.append(receipt);
    report.receipts.push(receipt);
  };

  const expired = await activeLinks.listExpiredUnpurged(ranAt);
  for (const link of expired) {
    const ref = logRef(link.sumId);
    const expiresAtEpoch = Math.floor(new Date(link.expiresAt).getTime() / 1000);

    const documentDeleted = await summaries.delete(link.sumId);
    if (documentDeleted) await record(newReceipt({ sumId: link.sumId, uid: link.sumId, deleted: "record", mechanism: "purge_job", source: "purge", expiresAt: expiresAtEpoch, at: clock.nowIso() }));
    let pdfDeleted = false;
    if (link.pdfKey) {
      pdfDeleted = await pdf.delete(link.pdfKey);
      if (pdfDeleted) await record(newReceipt({ sumId: link.sumId, key: link.pdfKey, deleted: "pdf", mechanism: "purge_job", source: "purge", at: clock.nowIso() }));
    }
    let audioDeleted = false;
    if (link.audioKey) {
      audioDeleted = await audio.delete(link.audioKey);
      if (audioDeleted) await record(newReceipt({ sumId: link.sumId, key: link.audioKey, deleted: "audio", mechanism: "purge_job", source: "purge", at: clock.nowIso() }));
    }

    await activeLinks.setStatus(link.sumId, "purged");
    await audit.append({ event: "link.purged", sumId: link.sumId, actor: "system", at: clock.nowIso(), details: { documentDeleted, pdfDeleted, audioDeleted, expiresAt: link.expiresAt } });

    report.linksPurged += 1;
    if (documentDeleted) report.documentsDeleted += 1;
    if (pdfDeleted) report.pdfsDeleted += 1;
    if (audioDeleted) report.audioDeleted += 1;
    report.purged.push({ linkRef: ref, expiresAt: link.expiresAt, documentDeleted, pdfDeleted, audioDeleted });
    log.info({ link: ref, documentDeleted, pdfDeleted, audioDeleted }, "link purged");
  }

  // Backstop 1 (twin of DynamoDB TTL): any item past its TTL that the loop above did not reach.
  for (const item of await summaries.listExpired(clock.nowEpochSeconds())) {
    if (!(await summaries.delete(item.uid))) continue;
    await record(newReceipt({ sumId: item.uid, uid: item.uid, deleted: "record", mechanism: "local_sweeper", source: "sweeper", expiresAt: item.expiresAt, at: clock.nowIso() }));
    report.orphanDocumentsDeleted += 1;
  }
  // Backstop 2 (twin of the S3 lifecycle rules): objects written more than 30 days ago in either bucket.
  for (const store of [pdf, audio]) {
    for (const obj of await store.listExpired(clock.now(), ctx.linkTtlDays)) {
      if (!(await store.delete(obj.key))) continue;
      await record(newReceipt({ sumId: obj.key.split(".")[0], key: obj.key, deleted: objectKindFor(obj.key) ?? "audio", mechanism: "local_sweeper", source: "sweeper", at: clock.nowIso() }));
      report.orphanObjectsDeleted += 1;
    }
  }

  await audit.append({ event: "purge.run", actor: "system", at: clock.nowIso(), details: { linksPurged: report.linksPurged, documentsDeleted: report.documentsDeleted, pdfsDeleted: report.pdfsDeleted, audioDeleted: report.audioDeleted, orphanDocumentsDeleted: report.orphanDocumentsDeleted, orphanObjectsDeleted: report.orphanObjectsDeleted, receipts: report.receipts.length } });
  return report;
}
