import { newReceipt, type DeletionReceipt } from "../audit/receipts.js";
import type { AppContext } from "../context.js";
import { hashLinkId, hashPrefix } from "../crypto/linkId.js";
import { pkFor, uidFor } from "../docstore/types.js";

export interface PurgeReport {
  ranAt: string;
  linksPurged: number;
  documentsDeleted: number;
  audioDeleted: number;
  orphanDocumentsDeleted: number;
  orphanAudioDeleted: number;
  purged: { linkIdHashPrefix: string; expiresAt: string; documentsDeleted: number; audioDeleted: boolean }[];
  receipts: DeletionReceipt[];
}

/**
 * The 30-day self-destruct, in code. For every link past its expiry:
 *   1. destroy the data key (crypto-shredding: anything still stored is unreadable from this moment),
 *   2. delete the document-store items and the audio object, writing one deletion receipt each,
 *   3. mark the link purged and clear the patient's active link,
 *   4. write audit events.
 * Then the backstop sweeps, the local twins of DynamoDB TTL and the S3 lifecycle rule: any item or
 * audio object past 30 days that the loop above did not reach is deleted with a receipt.
 * Read paths check expiry on their own, so a purge that has not run yet never exposes data.
 */
export async function runPurge(ctx: AppContext): Promise<PurgeReport> {
  const { links, patients, audit, docStore, audio, receipts, clock, log } = ctx;
  const ranAt = clock.nowIso();
  const report: PurgeReport = { ranAt, linksPurged: 0, documentsDeleted: 0, audioDeleted: 0, orphanDocumentsDeleted: 0, orphanAudioDeleted: 0, purged: [], receipts: [] };
  const record = async (receipt: DeletionReceipt) => {
    await receipts.append(receipt);
    report.receipts.push(receipt);
  };

  const expired = await links.listExpiredUnpurged(ranAt);
  for (const link of expired) {
    const prefix = hashPrefix(link.linkIdHash);
    await links.destroyKey(link.linkIdHash);
    await audit.append({ event: "key.destroyed", linkIdHash: link.linkIdHash, actor: "system", at: clock.nowIso(), details: { keyVersion: link.keyVersion } });

    const pk = pkFor(link.linkIdHash);
    let deleted = 0;
    for (const item of await docStore.list(pk)) {
      await docStore.delete(item.pk, item.sk);
      await record(newReceipt({ linkIdHash: link.linkIdHash, uid: uidFor(item.pk, item.sk), deleted: "record", mechanism: "purge_job", source: "purge", expiresAt: item.expiresAt, at: clock.nowIso() }));
      deleted += 1;
    }
    let audioDeleted = false;
    if (link.audioKey) {
      audioDeleted = await audio.delete(link.audioKey);
      if (audioDeleted) await record(newReceipt({ linkIdHash: link.linkIdHash, key: link.audioKey, deleted: "audio", mechanism: "purge_job", source: "purge", at: clock.nowIso() }));
    }

    await links.setStatus(link.linkIdHash, "purged");
    const patient = await patients.getById(link.patientId);
    if (patient?.activeLinkId && hashLinkId(patient.activeLinkId) === link.linkIdHash) {
      await patients.clearActiveLink(patient.id, patient.activeLinkId);
    }
    await audit.append({ event: "link.purged", linkIdHash: link.linkIdHash, actor: "system", at: clock.nowIso(), details: { documentsDeleted: deleted, audioDeleted, expiresAt: link.expiresAt } });

    report.linksPurged += 1;
    report.documentsDeleted += deleted;
    if (audioDeleted) report.audioDeleted += 1;
    report.purged.push({ linkIdHashPrefix: prefix, expiresAt: link.expiresAt, documentsDeleted: deleted, audioDeleted });
    log.info({ link: prefix, documentsDeleted: deleted, audioDeleted }, "link purged");
  }

  // Backstop 1 (twin of DynamoDB TTL): any document past its TTL that the loop above did not reach.
  for (const item of await docStore.listExpired(clock.nowEpochSeconds())) {
    await docStore.delete(item.pk, item.sk);
    await record(newReceipt({ linkIdHash: item.pk, uid: uidFor(item.pk, item.sk), deleted: "record", mechanism: "local_sweeper", source: "sweeper", at: clock.nowIso() }));
    report.orphanDocumentsDeleted += 1;
  }
  // Backstop 2 (twin of the S3 lifecycle rule): audio objects written more than 30 days ago.
  for (const obj of await audio.listExpired(clock.now(), ctx.linkTtlDays)) {
    if (!(await audio.delete(obj.key))) continue;
    await record(newReceipt({ linkIdHash: obj.key.split(".")[0], key: obj.key, deleted: "audio", mechanism: "local_sweeper", source: "sweeper", at: clock.nowIso() }));
    report.orphanAudioDeleted += 1;
  }

  await audit.append({ event: "purge.run", actor: "system", at: clock.nowIso(), details: { linksPurged: report.linksPurged, documentsDeleted: report.documentsDeleted, audioDeleted: report.audioDeleted, orphanDocumentsDeleted: report.orphanDocumentsDeleted, orphanAudioDeleted: report.orphanAudioDeleted, receipts: report.receipts.length } });
  return report;
}
