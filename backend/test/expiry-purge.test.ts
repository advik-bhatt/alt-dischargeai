import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashLinkId } from "../src/crypto/linkId.js";
import { aadFor, open } from "../src/crypto/envelope.js";
import { pkFor } from "../src/docstore/types.js";
import { createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("30-day expiry at read time and the purge job", () => {
  let t: TestApp;
  let linkId: string;
  let patientId: string;
  beforeAll(async () => {
    t = await createTestApp();
    ({ linkId, patientId } = await ingestText(t, exampleText("example-1-chf")));
    await request(t.app).get(`/translate?link=${linkId}&language=es`);
  });
  afterAll(() => t.close());

  it("serves the summary on day 29 and returns 410 on day 30 without any purge having run", async () => {
    const ok = await request(t.app).get(`/summary?link=${linkId}`);
    expect(ok.status).toBe(200);
    expect(ok.body.daysLeft).toBe(30);

    t.ctx.clock.advanceDays(29);
    const day29 = await request(t.app).get(`/summary?link=${linkId}`);
    expect(day29.status).toBe(200);
    expect(day29.body.daysLeft).toBe(1);

    t.ctx.clock.advanceDays(1);
    const day30 = await request(t.app).get(`/summary?link=${linkId}`);
    expect(day30.status).toBe(410);
    expect(day30.body.error).toBe("link_expired");
    const translate = await request(t.app).get(`/translate?link=${linkId}&language=es`);
    expect(translate.status).toBe(410);
  });

  it("purge destroys the key, deletes every document, marks the link purged and clears the patient's active link", async () => {
    const hash = hashLinkId(linkId);
    const before = await t.ctx.links.getByHash(hash);
    expect(before?.encKey).not.toBeNull();
    const docsBefore = await t.ctx.docStore.list(pkFor(hash));
    expect(docsBefore.map((d) => d.sk).sort()).toEqual(["raw", "simplified", "translation#es"]);
    const keptCiphertext = docsBefore.find((d) => d.sk === "simplified")!;
    const keptKey = Buffer.from(before!.encKey!);

    const report = await t.ctx.purge();
    expect(report.linksPurged).toBe(1);
    expect(report.documentsDeleted).toBe(3);

    const after = await t.ctx.links.getByHash(hash);
    expect(after?.status).toBe("purged");
    expect(after?.encKey).toBeNull();
    expect(await t.ctx.docStore.list(pkFor(hash))).toEqual([]);
    const patient = await t.ctx.patients.getById(patientId);
    expect(patient?.activeLinkId).toBeNull();

    // The only copy of the key is gone; the ciphertext we kept is unreadable with anything the system still holds.
    expect(() => open(Buffer.alloc(32), keptCiphertext, aadFor(pkFor(hash), "simplified", 1))).toThrow();
    expect(open(keptKey, keptCiphertext, aadFor(pkFor(hash), "simplified", 1)).length).toBeGreaterThan(0);

    const gone = await request(t.app).get(`/summary?link=${linkId}`);
    expect(gone.status).toBe(410);
    expect(gone.body.error).toBe("link_purged");

    const events = (await t.ctx.audit.listForLink(hash)).map((e) => e.event);
    expect(events).toContain("link.expired");
    expect(events).toContain("key.destroyed");
    expect(events).toContain("link.purged");
  });

  it("purge is idempotent and leaves unexpired links alone", async () => {
    const fresh = await ingestText(t, exampleText("example-3-hfpef-cellulitis"));
    const report = await t.ctx.purge();
    expect(report.linksPurged).toBe(0);
    const ok = await request(t.app).get(`/summary?link=${fresh.linkId}`);
    expect(ok.status).toBe(200);
  });

  it("DEMO_NOW pins the app clock at boot, so a second process can sweep 'day 30' against the same stores", async () => {
    const pinned = await createTestApp({ env: { DEMO_NOW: "2026-11-15T12:00:00.000Z" } });
    try {
      const health = await request(pinned.app).get("/health");
      expect(Math.abs(new Date(health.body.clock.now).getTime() - Date.parse("2026-11-15T12:00:00.000Z"))).toBeLessThan(5000);
      expect(health.body.clock.demoNow).toBe("2026-11-15T12:00:00.000Z");
      const { expiresAt } = await ingestText(pinned, exampleText("example-1-chf"));
      expect(expiresAt.slice(0, 10)).toBe("2026-12-15");
    } finally {
      await pinned.close();
    }
  });
});
