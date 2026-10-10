import { existsSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PATIENT_EN, createTestApp, examplePdf, exampleText, ingestPdf, ingestText, type TestApp } from "./helpers.js";

describe("30-day expiry at read time, the purge job and its deletion receipts", () => {
  let t: TestApp;
  let sumId: string;
  let pdfSumId: string;
  let audioSumId: string;
  let expiresAt: string;
  beforeAll(async () => {
    t = await createTestApp();
    ({ sumId, expiresAt } = await ingestText(t, exampleText("example-1-chf")));
    await request(t.app).get(`/translation?lang=es&sum_id=${sumId}`);
    ({ sumId: pdfSumId } = await ingestPdf(t, examplePdf("example-1-chf")));
    const audio = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", PATIENT_EN)
      .attach("audio", Buffer.from("RIFF....WAVEfmt fake audio bytes"), { filename: "dictation.wav", contentType: "audio/wav" });
    audioSumId = audio.body.sumId;
    await t.ctx.queue.onIdle();
  });
  afterAll(() => t.close());

  it("keeps the PDF and the audio clip under the sumId in their stores and records the keys on the activeLinks row and the item", async () => {
    const pdfLink = await t.ctx.activeLinks.getBySumId(pdfSumId);
    expect(pdfLink?.pdfKey).toBe(`${pdfSumId}.pdf`);
    expect(existsSync(join(t.dir, "pdf", `${pdfSumId}.pdf`))).toBe(true);
    expect((await t.ctx.summaries.get(pdfSumId))?.pdfKey).toBe(`${pdfSumId}.pdf`);
    const audioLink = await t.ctx.activeLinks.getBySumId(audioSumId);
    expect(audioLink?.audioKey).toBe(`${audioSumId}.wav`);
    expect(existsSync(join(t.dir, "audio", `${audioSumId}.wav`))).toBe(true);
    expect((await t.ctx.audio.get(audioLink!.audioKey!))?.body.toString()).toContain("WAVEfmt");
    const health = await request(t.app).get("/health");
    expect(health.body.providers.pdf).toMatchObject({ store: "local", requested: "local", bucket: "emrpdf-rh", fallbackReason: null });
    expect(health.body.providers.audio).toMatchObject({ store: "local", requested: "local", bucket: "emraudio-rh", fallbackReason: null });
    expect(health.body.providers.receipts).toBe("sql");
    expect(health.body.providers.docStore).toBe("local");
  });

  it("serves the summary on day 29 and answers 410 on day 30 on every patient route before any purge has run", async () => {
    const ok = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.daysLeft).toBe(30);
    expect(ok.body.expiresAt).toBe(expiresAt);

    t.ctx.clock.advanceDays(29);
    const day29 = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(day29.status).toBe(200);
    expect(day29.body.daysLeft).toBe(1);

    t.ctx.clock.advanceDays(1);
    const day30 = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(day30.status).toBe(410);
    expect(day30.body).toMatchObject({ statusCode: 410, error: "link_expired", expiresAt });
    expect((await request(t.app).get(`/translation?lang=es&sum_id=${sumId}`)).status).toBe(410);
    expect((await request(t.app).get(`/summary?link=${sumId}`)).status).toBe(410);
    expect((await request(t.app).get(`/translate?link=${sumId}&language=es`)).status).toBe(410);
    expect((await request(t.app).get(`/p/${sumId}`)).status).toBe(410);
    // The item is still in the store until the purge job runs; the read path never exposes it.
    expect(await t.ctx.summaries.get(sumId)).not.toBeNull();
    expect((await t.ctx.activeLinks.getBySumId(sumId))?.status).toBe("expired");
  });

  it("purge deletes every summary item, the PDF and the audio clip, writes one receipt per deletion, marks the links purged and clears the active link", async () => {
    const before = await t.ctx.summaries.get(sumId);
    expect(Object.keys(before!.translations)).toEqual(["es"]);
    expect(before!["llm-summary"]).toBeTruthy();

    const report = await t.ctx.purge();
    expect(report.linksPurged).toBe(3);
    expect(report.documentsDeleted).toBe(3);
    expect(report.pdfsDeleted).toBe(1);
    expect(report.audioDeleted).toBe(1);
    expect(report.orphanDocumentsDeleted).toBe(0);
    expect(report.orphanObjectsDeleted).toBe(0);
    expect(report.receipts).toHaveLength(5);

    for (const id of [sumId, pdfSumId, audioSumId]) {
      expect((await t.ctx.activeLinks.getBySumId(id))?.status).toBe("purged");
      expect(await t.ctx.summaries.get(id)).toBeNull();
    }
    expect(existsSync(join(t.dir, "pdf", `${pdfSumId}.pdf`))).toBe(false);
    expect(existsSync(join(t.dir, "audio", `${audioSumId}.wav`))).toBe(false);
    const patient = await t.provider(request(t.app).get(`/patients/${PATIENT_EN}`));
    expect(patient.body.activeLink).toBeNull();

    const gone = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("link_purged");
    expect((await request(t.app).get(`/p/${pdfSumId}`)).body.error).toBe("link_purged");

    const events = (await t.ctx.audit.listForLink(sumId)).map((e) => e.event);
    expect(events).toContain("link.expired");
    expect(events).toContain("link.purged");
    expect(events).toContain("deletion.receipt");

    const receipts = await t.ctx.receipts.findBySumId(sumId);
    expect(receipts.map((r) => [r.deleted, r.mechanism, r.source, r.uid])).toEqual([["record", "purge_job", "purge", sumId]]);
    expect(receipts[0].expiresAt).toBe(Math.floor(new Date(expiresAt).getTime() / 1000));
    expect((await t.ctx.receipts.findBySumId(pdfSumId)).map((r) => [r.deleted, r.uid ?? r.key])).toEqual([
      ["record", pdfSumId],
      ["pdf", `${pdfSumId}.pdf`],
    ]);
    expect((await t.ctx.receipts.findBySumId(audioSumId)).map((r) => [r.deleted, r.uid ?? r.key])).toEqual([
      ["record", audioSumId],
      ["audio", `${audioSumId}.wav`],
    ]);
    const serialized = JSON.stringify(await t.ctx.receipts.list());
    expect(serialized).not.toContain("Furosemide");
    expect(serialized).not.toContain("72-year-old");
    expect(serialized).not.toContain("harold");
  });

  it("purge is idempotent and leaves unexpired links alone", async () => {
    const fresh = await ingestText(t, exampleText("example-3-hfpef-cellulitis"));
    const report = await t.ctx.purge();
    expect(report.linksPurged).toBe(0);
    expect(report.receipts).toEqual([]);
    const ok = await request(t.app).get(`/llm-sumary?sum-id=${fresh.sumId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.daysLeft).toBe(30);
  });

  it("the backstop sweep deletes an expired item that has no activeLinks row, with a receipt", async () => {
    const orphan = "orphanorphanorphanorph";
    await t.ctx.summaries.put({ uid: orphan, "sum-id": orphan, patientID: PATIENT_EN, translations: {}, language: "en", status: "ready", createdAt: "2026-01-01T00:00:00.000Z", expiresAt: 1, inputKind: "text" });
    const report = await t.ctx.purge();
    expect(report.linksPurged).toBe(0);
    expect(report.orphanDocumentsDeleted).toBe(1);
    expect(report.receipts.map((r) => [r.deleted, r.mechanism, r.uid])).toEqual([["record", "local_sweeper", orphan]]);
    expect(await t.ctx.summaries.get(orphan)).toBeNull();
  });

  it("DEMO_NOW pins the app clock at boot, so a second process can sweep 'day 30' against the same stores", async () => {
    const pinned = await createTestApp({ env: { DEMO_NOW: "2026-11-15T12:00:00.000Z" } });
    try {
      const health = await request(pinned.app).get("/health");
      expect(Math.abs(new Date(health.body.clock.now).getTime() - Date.parse("2026-11-15T12:00:00.000Z"))).toBeLessThan(5000);
      expect(health.body.clock.demoNow).toBe("2026-11-15T12:00:00.000Z");
      const { expiresAt: e } = await ingestText(pinned, exampleText("example-1-chf"));
      expect(e.slice(0, 10)).toBe("2026-12-15");
    } finally {
      await pinned.close();
    }
  });
});
