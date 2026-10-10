import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfflineSimplifier } from "../src/pipeline/simplify.js";
import { AI_KEYS, PATIENT_EN, PATIENT_ES, VIEW_KEYS, createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("POST /ingest (text) -> 202 -> job -> GET /summary", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("rejects empty input with 400 empty_input", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", PATIENT_EN).field("text", "   \n ");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("empty_input");
  });

  it("rejects an unknown patient with 404 and an unknown language with 400", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", "nope").field("text", "Furosemide 40 mg daily");
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("patient_not_found");
    const lang = await t.provider(request(t.app).post("/ingest")).field("patientId", PATIENT_EN).field("text", "Furosemide 40 mg daily").field("language", "klingon");
    expect(lang.status).toBe(400);
    expect(lang.body.error).toBe("invalid_language");
  });

  it("answers 202 'ingestion started' with a link, runs the pipeline, emails the patient, serves the fixed JSON", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", PATIENT_EN).field("text", exampleText("example-1-chf"));
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("ingestion started");
    expect(res.body.linkId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.body.link).toBe(`http://localhost:5173/s/${res.body.linkId}`);
    expect(res.body.statusUrl).toBe(`/jobs/${res.body.jobId}`);
    expect(res.body.language).toBe("en");
    const created = new Date(res.body.expiresAt).getTime() - t.ctx.clock.now().getTime();
    expect(Math.round(created / (24 * 3600 * 1000))).toBe(30);

    // Still processing until the queue drains: 425, never a partial summary.
    const early = await request(t.app).get(`/summary?link=${res.body.linkId}`);
    expect([425, 200]).toContain(early.status);
    await t.ctx.queue.onIdle();

    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.status).toBe(200);
    expect(job.body.stage).toBe("done");
    expect(job.body.verified).toBe(true);
    expect(job.body.safety.passed).toBe(true);
    expect(job.body.safety.dropped).toEqual([]);
    expect(job.body.meta.fixture).toBe("example-1");
    expect(job.body.languages).toEqual(["en"]);
    expect(JSON.stringify(job.body)).not.toContain("72-year-old");

    expect(t.mailer.sent).toHaveLength(1);
    expect(t.mailer.sent[0].to).toBe("harold.jennings@example.test");
    expect(t.mailer.sent[0].text).toContain(`Your discharge summary is ready at this link: ${res.body.link}`);
    expect(t.mailer.sent[0].text).not.toContain("Furosemide");

    const summary = await request(t.app).get(`/summary?link=${res.body.linkId}`);
    expect(summary.status).toBe(200);
    expect(Object.keys(summary.body).sort()).toEqual([...VIEW_KEYS].sort());
    expect(summary.body.language).toBe("en");
    expect(summary.body.medications.map((m: { name: string; dose: string }) => `${m.name} ${m.dose}`)).toContain("Furosemide 40 mg");
    expect(summary.body.steps[0].text).toMatch(/Furosemide 40 mg/);
    expect(summary.body.daysLeft).toBe(30);
    expect(summary.body.availableLanguages).toEqual(["en"]);
    expect(summary.body.fromCache).toBe(true);
    for (const key of ["summary", "checklist", "diagnoses", "readingLevel", "verification", "needsReview"]) expect(summary.body).not.toHaveProperty(key);

    const patient = await t.provider(request(t.app).get(`/patients/${PATIENT_EN}`));
    expect(patient.body.activeLinkId).toBe(res.body.linkId);
    expect(patient.body.activeLinkExpiresAt).toBe(res.body.expiresAt);
  });

  it("produces the provider-picked language at ingest and serves it from the cache", async () => {
    const { linkId, language } = await ingestText(t, exampleText("example-1-chf"), { language: "Spanish" }, PATIENT_ES);
    expect(language).toBe("es");
    const en = await request(t.app).get(`/summary?link=${linkId}`);
    expect(en.body.availableLanguages).toEqual(["en", "es"]);
    const es = await request(t.app).get(`/translate?link=${linkId}&language=es`);
    expect(es.status).toBe(200);
    expect(es.body.fromCache).toBe(true);
    expect(es.body.language).toBe("es");
    expect(es.body.steps[0].text).toMatch(/^Tome Furosemide 40 mg/);
    expect(Object.keys(es.body).sort()).toEqual([...VIEW_KEYS].sort());
    const viaSummary = await request(t.app).get(`/summary?link=${linkId}&language=Spanish`);
    expect(viaSummary.body.steps).toEqual(es.body.steps);
  });

  it("defaults the language to the patient's preference", async () => {
    const { language, linkId } = await ingestText(t, exampleText("example-2-sepsis-uti"), {}, PATIENT_ES);
    expect(language).toBe("es");
    const es = await request(t.app).get(`/summary?link=${linkId}`);
    expect(es.body.availableLanguages).toEqual(["en", "es"]);
  });

  it("falls back to rule-based extraction for text that matches no fixture", async () => {
    const text = [
      "Discharge diagnoses:",
      "• Community-acquired pneumonia",
      "• Hypertension",
      "Discharge Medications",
      "New medications",
      "• Azithromycin 250 mg by mouth once daily for 4 additional days.",
      "Continue",
      "• Amlodipine 10 mg daily.",
      "Stopped/held",
      "• Lisinopril — held pending blood pressure recheck.",
      "Discharge Instructions",
      "• Follow up with primary care within 1 week.",
      "Return Precautions",
      "• Chest pain.",
      "• Fever above 101 F.",
    ].join("\n");
    const { linkId, jobId } = await ingestText(t, text);
    const job = await t.provider(request(t.app).get(`/jobs/${jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.meta.model).toBe("rules");
    const summary = await request(t.app).get(`/summary?link=${linkId}`);
    expect(Object.keys(summary.body).filter((k) => AI_KEYS.includes(k)).sort()).toEqual([...AI_KEYS].sort());
    expect(summary.body.medications[0]).toMatchObject({ name: "Azithromycin", dose: "250 mg", status: "new" });
    expect(summary.body.medications.find((m: { name: string }) => m.name === "Lisinopril").status).toBe("stop");
    expect(summary.body.followUps[0].who).toBe("primary care");
    expect(summary.body.warnings[0]).toEqual({ text: "Chest pain.", tier: "call911" });
  });

  it("blocks a summary that dropped a medication: needs_review, 423 for the patient, no email", async () => {
    const base = new OfflineSimplifier();
    const dropping = {
      name: "dropping",
      async simplify(input: { text: string }) {
        const r = await base.simplify(input);
        r.output.medications = r.output.medications.filter((m) => m.name !== "Metformin");
        return r;
      },
    };
    const blocked = await createTestApp({ simplifier: dropping });
    try {
      const sentBefore = blocked.mailer.sent.length;
      const { linkId, jobId } = await ingestText(blocked, exampleText("example-1-chf"), { language: "es" });
      const job = await blocked.provider(request(blocked.app).get(`/jobs/${jobId}`));
      expect(job.body.stage).toBe("needs_review");
      expect(job.body.verified).toBe(false);
      expect(job.body.safety.dropped).toEqual([expect.objectContaining({ name: "Metformin", missing: ["medication"] })]);
      expect(job.body.safety.reason).toBe("safety_check_failed dropped=1 unsupported=0");
      expect(job.body.meta.skipped).toEqual([{ language: "es", reason: "blocked_by_safety_checks" }]);
      expect(blocked.mailer.sent.length).toBe(sentBefore);
      const res = await request(blocked.app).get(`/summary?link=${linkId}`);
      expect(res.status).toBe(423);
      expect(res.body.error).toBe("needs_review");
      expect(JSON.stringify(res.body)).not.toContain("Metformin");
    } finally {
      await blocked.close();
    }
  });
});
