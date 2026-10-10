import type { AppContext } from "../context.js";
import { hashLinkId, hashPrefix } from "../crypto/linkId.js";

export interface PurgeReport {
  ranAt: string;
  linksPurged: number;
  documentsDeleted: number;
  orphanDocumentsDeleted: number;
  purged: { linkIdHashPrefix: string; expiresAt: string; documentsDeleted: number }[];
}

/**
 * The 30-day self-destruct, in code. For every link past its expiry:
 *   1. destroy the data key (crypto-shredding: anything still stored is unreadable from this moment),
 *   2. delete the document-store items,
 *   3. mark the link purged, clear the patient's active link, drop the checklist state,
 *   4. write audit events.
 * Read paths check expiry on their own, so a purge that has not run yet never exposes data.
 * DynamoDB TTL on `expiresAt` is a backstop; AWS deletes expired items "typically within a few days".
 */
export async function runPurge(ctx: AppContext): Promise<PurgeReport> {
  const { links, patients, audit, secureDocs, docStore, checklist, clock, log } = ctx;
  const ranAt = clock.nowIso();
  const report: PurgeReport = { ranAt, linksPurged: 0, documentsDeleted: 0, orphanDocumentsDeleted: 0, purged: [] };

  const expired = await links.listExpiredUnpurged(ranAt);
  for (const link of expired) {
    const prefix = hashPrefix(link.linkIdHash);
    await links.destroyKey(link.linkIdHash);
    await audit.append({ event: "key.destroyed", linkIdHash: link.linkIdHash, actor: "system", at: clock.nowIso(), details: { keyVersion: link.keyVersion } });

    const deleted = await secureDocs.deleteAll(link.linkIdHash);

    await links.setStatus(link.linkIdHash, "purged");
    const patient = await patients.getById(link.patientId);
    if (patient?.activeLinkId && hashLinkId(patient.activeLinkId) === link.linkIdHash) {
      await patients.clearActiveLink(patient.id, patient.activeLinkId);
    }
    await checklist.deleteForLink(link.linkIdHash);
    await audit.append({ event: "link.purged", linkIdHash: link.linkIdHash, actor: "system", at: clock.nowIso(), details: { documentsDeleted: deleted, expiresAt: link.expiresAt } });

    report.linksPurged += 1;
    report.documentsDeleted += deleted;
    report.purged.push({ linkIdHashPrefix: prefix, expiresAt: link.expiresAt, documentsDeleted: deleted });
    log.info({ link: prefix, documentsDeleted: deleted }, "link purged");
  }

  // Backstop sweep: any document past its TTL that the loop above did not reach.
  const stale = await docStore.listExpired(clock.nowEpochSeconds());
  for (const item of stale) {
    await docStore.delete(item.pk, item.sk);
    report.orphanDocumentsDeleted += 1;
  }

  await audit.append({ event: "purge.run", actor: "system", at: clock.nowIso(), details: { linksPurged: report.linksPurged, documentsDeleted: report.documentsDeleted, orphanDocumentsDeleted: report.orphanDocumentsDeleted } });
  return report;
}
