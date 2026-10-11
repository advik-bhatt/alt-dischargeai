import { readFileSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AiOutputSchema, type AiOutput } from "../src/contracts/aiOutput.js";
import type { SummaryItem } from "../src/docstore/types.js";
import { OfflineSimplifier } from "../src/pipeline/simplify.js";
import { FIXTURES, PATIENT_EN, createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

/** Task 4 of the backend tasks doc: GET /llm-sumary?sum-id=... (spelled so) reads the llm-summary from the DynamoDB item. */
describe("GET /llm-sumary?sum-id= (task 4)", () => {
  let t: TestApp;
  let sumId: string;
  beforeAll(async () => {
    t = await createTestApp();
    ({ sumId } = await ingestText(t, exampleText("example-1-chf")));
  });
  afterAll(() => t.close());

  it("returns the llm-summary saved on the item, with sum-id, expiry and the languages held", async () => {
    const res = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ "sum-id": sumId, sumId, patientID: PATIENT_EN, language: "en", status: "ready", daysLeft: 30, availableLanguages: ["en"] });
    expect(AiOutputSchema.parse(res.body["llm-summary"])).toEqual(res.body["llm-summary"]);
    // It is exactly what the DynamoDB item (here its SQL twin) holds under llm-summary.
    expect(res.body["llm-summary"]).toEqual((await t.ctx.summaries.get(sumId))?.["llm-summary"]);
  });

  it("serves the same item on /llm-summary and with ?sum_id=", async () => {
    const exact = (await request(t.app).get(`/llm-sumary?sum-id=${sumId}`)).body["llm-summary"];
    for (const url of [`/llm-summary?sum-id=${sumId}`, `/llm-sumary?sum_id=${sumId}`, `/llm-summary?sum_id=${sumId}`]) {
      const res = await request(t.app).get(url);
      expect(res.status, url).toBe(200);
      expect(res.body["llm-summary"], url).toEqual(exact);
    }
  });

  it("answers 400 without a sum-id or with a malformed one, and 404 for a well-formed id nobody issued", async () => {
    const missing = await request(t.app).get("/llm-sumary");
    expect(missing.status).toBe(400);
    expect(missing.body).toMatchObject({ statusCode: 400, error: "missing_sum_id" });
    const malformed = await request(t.app).get("/llm-sumary?sum-id=abc");
    expect(malformed.status).toBe(400);
    expect(malformed.body).toMatchObject({ statusCode: 400, error: "invalid_link" });
    const unknown = await request(t.app).get("/llm-sumary?sum-id=AAAAAAAAAAAAAAAAAAAAAA");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ statusCode: 404, error: "link_not_found" });
  });

  it("answers 425 while the LLM is still working, then 200 once it returned", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = new OfflineSimplifier();
    const slow = {
      name: "slow",
      async simplify(input: { text: string }) {
        await gate;
        return base.simplify(input);
      },
    };
    const app = await createTestApp({ simplifier: slow });
    try {
      const res = await app.provider(request(app.app).post("/ingest")).send({ data: exampleText("example-1-chf"), type: "text", patientID: PATIENT_EN });
      expect(res.status).toBe(202);
      const early = await request(app.app).get(`/llm-sumary?sum-id=${res.body.sumId}`);
      expect(early.status).toBe(425);
      expect(early.body).toMatchObject({ statusCode: 425, error: "processing" });
      release();
      await app.ctx.queue.onIdle();
      expect((await request(app.app).get(`/llm-sumary?sum-id=${res.body.sumId}`)).status).toBe(200);
    } finally {
      release();
      await app.close();
    }
  });

  it("answers 410 once expiresAt has passed, at read time, before any purge ran", async () => {
    const app = await createTestApp();
    try {
      const { sumId: id } = await ingestText(app, exampleText("example-1-chf"));
      app.ctx.clock.advanceDays(30);
      const res = await request(app.app).get(`/llm-sumary?sum-id=${id}`);
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ statusCode: 410, error: "link_expired" });
      // The item is still in the store: the 410 came from the read-time check, not from a deletion.
      expect(await app.ctx.summaries.get(id)).toBeTruthy();
    } finally {
      await app.close();
    }
  });
});

/**
 * The tasks doc has GET /llm-sumary and GET /translation read "from the dynamodb table". An item
 * written straight into the table (a teammate's agent, or by hand) has no activeLinks row, and must
 * read correctly, judged by its own status and expiresAt.
 */
describe("items that exist only in the document store (no activeLinks row)", () => {
  const english = JSON.parse(readFileSync(join(FIXTURES, "offline", "ai-output", "example-1.en.json"), "utf8")) as AiOutput;
  const spanish = JSON.parse(readFileSync(join(FIXTURES, "offline", "ai-output", "example-1.es.json"), "utf8")) as AiOutput;
  const SAMPLE = "sampledischargesummary";
  let t: TestApp;
  const base = (uid: string, over: Partial<SummaryItem> = {}): SummaryItem => ({
    uid,
    "sum-id": uid,
    patientID: "sample-patient",
    "raw-text": exampleText("example-1-chf"),
    "llm-summary": english,
    status: "ready",
    createdAt: t.ctx.clock.nowIso(),
    expiresAt: Math.floor(t.ctx.clock.now().getTime() / 1000) + 30 * 86400,
    inputKind: "text",
    ...over,
  });
  const linkRows = async () => Number((await t.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM activeLinks"))?.n);

  beforeAll(async () => {
    t = await createTestApp({ translator: undefined });
    await t.ctx.summaries.put(base(SAMPLE, { translations: { es: spanish } }));
  });
  afterAll(() => t.close());

  it("GET /llm-sumary returns the llm-summary, with its expiry from the item, and creates no SQL row", async () => {
    const res = await request(t.app).get(`/llm-sumary?sum-id=${SAMPLE}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ "sum-id": SAMPLE, sumId: SAMPLE, patientID: "sample-patient", language: "en", status: "ready", daysLeft: 30, availableLanguages: ["en", "es"] });
    expect(res.body["llm-summary"]).toEqual(english);
    expect(new Date(res.body.expiresAt).getTime() / 1000).toBe((await t.ctx.summaries.get(SAMPLE))!.expiresAt);
    expect(await linkRows()).toBe(0);
    // The aliases read the same item.
    for (const url of [`/llm-summary?sum_id=${SAMPLE}`, `/summary?link=${SAMPLE}`, `/p/${SAMPLE}`]) {
      const alias = await request(t.app).get(url);
      expect(alias.status, url).toBe(200);
    }
  });

  it("GET /translation serves the stored translation, then translates a new language, saves it on the item and lists every language", async () => {
    const hit = await request(t.app).get(`/translation?lang=es&sum_id=${SAMPLE}`);
    expect(hit.status).toBe(200);
    expect(hit.body).toMatchObject({ lang: "es", fromCache: true, availableLanguages: ["en", "es"] });
    expect(hit.body.translation).toEqual(spanish);

    const miss = await request(t.app).get(`/translation?lang=zh&sum_id=${SAMPLE}`);
    expect(miss.status).toBe(200);
    expect(miss.body).toMatchObject({ lang: "zh", fromCache: false, availableLanguages: ["en", "es", "zh"] });
    expect(Object.keys((await t.ctx.summaries.get(SAMPLE))!.translations ?? {})).toEqual(["es", "zh"]);
    const again = await request(t.app).get(`/translation?lang=Mandarin&sum_id=${SAMPLE}`);
    expect(again.body).toMatchObject({ fromCache: true, availableLanguages: ["en", "es", "zh"] });
    expect(await linkRows()).toBe(0);
  });

  it("answers from the item's own status: 425 processing, 423 needs_review, 500 failed, 425 when there is no llm-summary yet", async () => {
    await t.ctx.summaries.put(base("processingprocessingpr", { status: "processing", "llm-summary": undefined }));
    await t.ctx.summaries.put(base("reviewreviewreviewrevi", { status: "needs_review" }));
    await t.ctx.summaries.put(base("failedfailedfailedfail", { status: "failed" }));
    await t.ctx.summaries.put(base("readynosummaryyyyyyyyy", { "llm-summary": undefined }));
    const get = async (id: string) => request(t.app).get(`/llm-sumary?sum-id=${id}`);
    expect((await get("processingprocessingpr")).status).toBe(425);
    const review = await get("reviewreviewreviewrevi");
    expect(review.status).toBe(423);
    expect(JSON.stringify(review.body)).not.toContain("Furosemide");
    expect((await get("failedfailedfailedfail")).status).toBe(500);
    expect((await get("readynosummaryyyyyyyyy")).status).toBe(425);
    expect((await get("neverwrittenneverwrite")).status).toBe(404);
  });

  it("answers 410 once the item's expiresAt has passed, at read time, while the item is still in the table", async () => {
    const id = "expiredexpiredexpiredx";
    await t.ctx.summaries.put(base(id, { expiresAt: Math.floor(t.ctx.clock.now().getTime() / 1000) - 60 }));
    const res = await request(t.app).get(`/llm-sumary?sum-id=${id}`);
    expect(res.status).toBe(410);
    expect(res.body).toMatchObject({ statusCode: 410, error: "link_expired" });
    expect((await request(t.app).get(`/translation?lang=es&sum_id=${id}`)).status).toBe(410);
    expect(await t.ctx.summaries.get(id)).toBeTruthy();
  });

  it("the purge backstop still deletes an expired item that has no link, with a receipt", async () => {
    const report = await t.ctx.purge();
    expect(report.receipts.some((r) => r.uid === "expiredexpiredexpiredx" && r.mechanism === "local_sweeper")).toBe(true);
    expect(await t.ctx.summaries.get("expiredexpiredexpiredx")).toBeNull();
    expect(await t.ctx.summaries.get(SAMPLE)).toBeTruthy();
  });
});
