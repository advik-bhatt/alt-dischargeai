import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AI_OUTPUT_KEYS, AiOutputSchema } from "../src/contracts/aiOutput.js";
import { OfflineSimplifier } from "../src/pipeline/simplify.js";
import { PATIENT_EN, VIEW_KEYS, createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("POST /synthesize and GET /p/:token", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("text mode runs lane 3 and returns the fixed JSON per language without storing anything", async () => {
    const res = await t.provider(request(t.app).post("/synthesize")).send({ text: exampleText("example-1-chf"), language: "Spanish", languages: ["zh"] });
    expect(res.status).toBe(200);
    expect(res.body.stored).toBe(false);
    expect(res.body.status).toBe("ready");
    expect(res.body.verified).toBe(true);
    expect(res.body.languages).toEqual(["en", "es", "zh"]);
    for (const lang of ["en", "es", "zh"]) {
      const out = res.body.perLanguage[lang];
      expect(Object.keys(out).sort()).toEqual([...AI_OUTPUT_KEYS].sort());
      expect(AiOutputSchema.safeParse(out).success).toBe(true);
      expect(out.language).toBe(lang);
    }
    expect(res.body.safety.passed).toBe(true);
    expect(res.body.safety.translations.map((x: { language: string; passed: boolean }) => [x.language, x.passed])).toEqual([["es", true], ["zh", true]]);
    expect(res.body.meta.fixture).toBe("example-1");
    expect(res.body.perLanguage.en).not.toHaveProperty("safety");
  });

  it("rejects a request with neither linkId nor text, an unknown link, and a bad language", async () => {
    expect((await t.provider(request(t.app).post("/synthesize")).send({})).body.error).toBe("empty_input");
    expect((await t.provider(request(t.app).post("/synthesize")).send({ linkId: "AAAAAAAAAAAAAAAAAAAAAA" })).status).toBe(404);
    expect((await t.provider(request(t.app).post("/synthesize")).send({ linkId: "short" })).body.error).toBe("invalid_link");
    expect((await t.provider(request(t.app).post("/synthesize")).send({ text: "x", language: "klingon" })).body.error).toBe("invalid_language");
    expect((await request(t.app).post("/synthesize").send({ text: "x" })).status).toBe(401);
  });

  it("linkId mode re-runs the pipeline over the stored raw text, replaces the stored languages, and GET /p/:token serves them", async () => {
    const { linkId } = await ingestText(t, exampleText("example-1-chf"));
    const onDemand = await request(t.app).get(`/translate?link=${linkId}&language=es`);
    expect(onDemand.body.fromCache).toBe(false);
    expect((await request(t.app).get(`/p/${linkId}`)).body.availableLanguages).toEqual(["en", "es"]);

    const res = await t.provider(request(t.app).post("/synthesize")).send({ linkId, language: "zh" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ stored: true, status: "ready", verified: true, emailed: true, languages: ["en", "zh"] });
    expect(res.body.perLanguage.zh.medications[0]).toMatchObject({ name: "Furosemide", dose: "40 mg" });
    expect(res.body.expiresAt).toMatch(/Z$/);

    const zh = await request(t.app).get(`/p/${linkId}?language=zh`);
    expect(zh.status).toBe(200);
    expect(zh.body.fromCache).toBe(true);
    expect(zh.body.language).toBe("zh");
    expect(Object.keys(zh.body).sort()).toEqual([...VIEW_KEYS].sort());
    const en = await request(t.app).get(`/p/${linkId}`);
    expect(en.body.language).toBe("en");
    expect(en.body.availableLanguages).toEqual(["en", "zh"]);
    expect(en.body.steps).toEqual((await request(t.app).get(`/summary?link=${linkId}`)).body.steps);
    // The earlier on-demand Spanish was produced for the previous English and is re-made on request.
    const es = await request(t.app).get(`/p/${linkId}?language=Spanish`);
    expect(es.status).toBe(200);
    expect(es.body.fromCache).toBe(false);
    expect((await request(t.app).get(`/p/${linkId}`)).body.availableLanguages).toEqual(["en", "zh", "es"]);
    expect(t.mailer.sent.filter((m) => m.text.includes(linkId))).toHaveLength(1);
  });

  it("a blocked summary is released by a re-run that passes the safety checks, and the patient is emailed once", async () => {
    const base = new OfflineSimplifier();
    let drop = true;
    const flaky = {
      name: "flaky",
      async simplify(input: { text: string }) {
        const r = await base.simplify(input);
        if (drop) r.output.medications = r.output.medications.filter((m) => m.name !== "Apixaban");
        return r;
      },
    };
    const app = await createTestApp({ simplifier: flaky });
    try {
      const { linkId, jobId } = await ingestText(app, exampleText("example-1-chf"), { language: "es" });
      expect((await app.provider(request(app.app).get(`/jobs/${jobId}`))).body.stage).toBe("needs_review");
      expect((await request(app.app).get(`/p/${linkId}`)).status).toBe(423);
      expect(app.mailer.sent).toHaveLength(0);

      drop = false;
      const res = await app.provider(request(app.app).post("/synthesize")).send({ linkId });
      expect(res.body).toMatchObject({ stored: true, status: "ready", verified: true, emailed: true, languages: ["en", "es"] });
      expect(app.mailer.sent).toHaveLength(1);
      expect(app.mailer.sent[0].text).toContain(linkId);
      const view = await request(app.app).get(`/p/${linkId}?language=es`);
      expect(view.status).toBe(200);
      expect(view.body.medications.map((m: { name: string }) => m.name)).toContain("Apixaban");

      const again = await app.provider(request(app.app).post("/synthesize")).send({ linkId });
      expect(again.body.emailed).toBe(true);
      expect(app.mailer.sent).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("GET /p/:token answers 400, 404 and 410 like GET /summary", async () => {
    expect((await request(t.app).get("/p/not-a-token")).status).toBe(400);
    expect((await request(t.app).get("/p/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    const { linkId } = await ingestText(t, exampleText("example-2-sepsis-uti"), {}, PATIENT_EN);
    expect((await request(t.app).get(`/p/${linkId}`)).status).toBe(200);
    t.ctx.clock.advanceDays(30);
    try {
      const gone = await request(t.app).get(`/p/${linkId}`);
      expect(gone.status).toBe(410);
      expect(gone.body.error).toBe("link_expired");
      expect((await t.provider(request(t.app).post("/synthesize")).send({ linkId })).status).toBe(410);
    } finally {
      t.ctx.clock.reset();
    }
  });
});
