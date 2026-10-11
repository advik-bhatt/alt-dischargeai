import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { OfflineSimplifier } from "../src/pipeline/simplify.js";
import { OfflineTranslator } from "../src/pipeline/translate.js";
import { AI_KEYS, LLM_SUMMARY_KEYS, PATIENT_EN, PATIENT_ES, PATIENT_NO_CAREGIVER, VIEW_KEYS, createTestApp, exampleText, ingestText, type TestApp } from "./helpers.js";

describe("POST /ingest (JSON, team contract) -> 202 -> job -> GET /llm-sumary", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("fails with the contract's message when type is not text or pdf", async () => {
    for (const type of ["audio", "docx", "", undefined]) {
      const res = await t.provider(request(t.app).post("/ingest")).send({ data: "x", type, patientID: PATIENT_EN });
      expect(res.status, String(type)).toBe(400);
      expect(res.body.statusCode).toBe(400);
      expect(res.body.message).toBe("type must be text or pdf");
      expect(res.body.error).toBe("invalid_type");
    }
  });

  it("rejects a missing patientID, empty data and an unknown patient", async () => {
    const noPatient = await t.provider(request(t.app).post("/ingest")).send({ data: "Furosemide 40 mg daily", type: "text" });
    expect(noPatient.status).toBe(400);
    expect(noPatient.body).toMatchObject({ statusCode: 400, error: "missing_patientID" });
    const empty = await t.provider(request(t.app).post("/ingest")).send({ data: "  \n ", type: "text", patientID: PATIENT_EN });
    expect(empty.body).toMatchObject({ statusCode: 400, error: "empty_input" });
    const unknown = await t.provider(request(t.app).post("/ingest")).send({ data: "Furosemide 40 mg daily", type: "text", patientID: "nope" });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ statusCode: 404, error: "patient_not_found" });
  });

  it("takes no language: a stray `language` is ignored, not validated, and nothing is translated", async () => {
    const app = await createTestApp();
    try {
      const res = await app.provider(request(app.app).post("/ingest")).send({ data: exampleText("example-1-chf"), type: "text", patientID: PATIENT_EN, language: "klingon" });
      expect(res.status).toBe(202);
      expect(res.body).not.toHaveProperty("language");
      await app.ctx.queue.onIdle();
      expect((await app.ctx.summaries.get(res.body.sumId))?.translations).toBeUndefined();
      expect((await request(app.app).get(`/llm-sumary?sum-id=${res.body.sumId}`)).body.availableLanguages).toEqual(["en"]);
    } finally {
      await app.close();
    }
  });

  it("answers 202 'ingestion started' at once, writes the activeLinks row, saves raw-text then llm-summary + sum-id on one item, emails patient and caregiver", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).send({ data: exampleText("example-1-chf"), type: "text", patientID: PATIENT_EN });
    expect(res.status).toBe(202);
    expect(res.body.statusCode).toBe(202);
    expect(res.body.message).toBe("ingestion started");
    expect(res.body.sumId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(res.body.linkId).toBe(res.body.sumId);
    expect(res.body.link).toBe(`http://localhost:5173/s/${res.body.sumId}`);
    expect(res.body.statusUrl).toBe(`/jobs/${res.body.jobId}`);
    expect(res.body).not.toHaveProperty("language");
    const created = new Date(res.body.expiresAt).getTime() - t.ctx.clock.now().getTime();
    expect(Math.round(created / (24 * 3600 * 1000))).toBe(30);
    const sumId = res.body.sumId as string;

    // The random path is in activeLinks as-is, the raw text is already on the item, before the LLM ran.
    const row = await t.ctx.db.get<{ sumId: string; patientID: string; status: string; expiresAt: string }>("SELECT sumId, patientID, status, expiresAt FROM activeLinks WHERE sumId = ?", [sumId]);
    expect(row).toMatchObject({ sumId, patientID: PATIENT_EN, expiresAt: res.body.expiresAt });
    const early = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect([425, 200]).toContain(early.status);
    // The text is on the DynamoDB item as `raw-text` already; only the LLM response is still to come.
    expect((await t.ctx.summaries.get(sumId))?.["raw-text"]).toContain("Furosemide 40 mg");
    await t.ctx.queue.onIdle();

    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.status).toBe(200);
    expect(job.body.stage).toBe("done");
    expect(job.body.sumId).toBe(sumId);
    expect(job.body.verified).toBe(true);
    expect(job.body.safety.passed).toBe(true);
    expect(job.body.meta.fixture).toBe("example-1");
    expect(job.body.languages).toEqual(["en"]);
    expect(job.body.safety).not.toHaveProperty("translations");
    expect(job.body.meta).not.toHaveProperty("skipped");
    expect(JSON.stringify(job.body)).not.toContain("72-year-old");

    const link = await t.ctx.activeLinks.getBySumId(sumId);
    expect(link).toMatchObject({ sumId, patientID: PATIENT_EN, status: "ready", languages: ["en"] });
    expect(link).not.toHaveProperty("language");
    expect(link?.emailedAt).toBeTruthy();

    // One item per summary, readable attributes, the contract's names.
    const item = await t.ctx.summaries.get(sumId);
    expect(item).toBeTruthy();
    expect(item!.uid).toBe(sumId);
    expect(item!["sum-id"]).toBe(sumId);
    expect(item!.patientID).toBe(PATIENT_EN);
    expect(item!["raw-text"]).toContain("Furosemide 40 mg");
    expect(item!["llm-summary"]?.medications.map((m) => m.name)).toContain("Furosemide");
    expect(Object.keys(item!["llm-summary"]!).sort()).toEqual([...AI_KEYS].sort());
    expect(item!.translations).toBeUndefined();
    expect(item).not.toHaveProperty("language");
    expect(item!.status).toBe("ready");
    expect(item!.expiresAt).toBe(Math.floor(new Date(res.body.expiresAt).getTime() / 1000));

    // Step 5: the link goes to the patient's email and to the caregiverEmail.
    expect(t.mailer.sent.map((m) => m.to)).toEqual(["harold.jennings@example.test", "june.jennings@example.test"]);
    expect(t.mailer.sent[0].text).toContain(`Your discharge summary is ready at this link: ${res.body.link}`);
    expect(t.mailer.sent[1].text).toContain(res.body.link);
    expect(t.mailer.sent.every((m) => !m.text.includes("Furosemide"))).toBe(true);

    const summary = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(summary.status).toBe(200);
    expect(Object.keys(summary.body).sort()).toEqual([...LLM_SUMMARY_KEYS].sort());
    expect(summary.body["sum-id"]).toBe(sumId);
    expect(summary.body["llm-summary"].medications.map((m: { name: string; dose: string }) => `${m.name} ${m.dose}`)).toContain("Furosemide 40 mg");
    expect(summary.body["llm-summary"].steps[0].text).toMatch(/Furosemide 40 mg/);
    expect(summary.body.daysLeft).toBe(30);
    expect(summary.body.availableLanguages).toEqual(["en"]);

    // The earlier route is an alias of the same item.
    const alias = await request(t.app).get(`/summary?link=${sumId}`);
    expect(alias.status).toBe(200);
    expect(Object.keys(alias.body).sort()).toEqual([...VIEW_KEYS].sort());
    expect(alias.body.steps).toEqual(summary.body["llm-summary"].steps);

    const patient = await t.provider(request(t.app).get(`/patients/${PATIENT_EN}`));
    expect(patient.body.activeLink).toMatchObject({ sumId, link: res.body.link, expiresAt: res.body.expiresAt, status: "ready" });
  });

  it("sends only one email when the patient has no caregiverEmail", async () => {
    const before = t.mailer.sent.length;
    const { link } = await ingestText(t, exampleText("example-2-sepsis-uti"), {}, PATIENT_NO_CAREGIVER);
    const sent = t.mailer.sent.slice(before);
    expect(sent.map((m) => m.to)).toEqual(["dmitri.volkov@example.test"]);
    expect(sent[0].text).toContain(link);
  });

  it("ingestion never calls the translation agent, even for a patient who prefers Spanish; GET /translation does, on demand", async () => {
    const translator = new OfflineTranslator();
    const spy = vi.spyOn(translator, "translate");
    const app = await createTestApp({ translator });
    try {
      const { sumId } = await ingestText(app, exampleText("example-1-chf"), {}, PATIENT_ES);
      expect(spy).not.toHaveBeenCalled();
      expect((await app.ctx.summaries.get(sumId))?.translations).toBeUndefined();
      expect((await request(app.app).get(`/llm-sumary?sum-id=${sumId}`)).body.availableLanguages).toEqual(["en"]);

      const first = await request(app.app).get(`/translation?lang=es&sum_id=${sumId}`);
      expect(first.status).toBe(200);
      expect(first.body.fromCache).toBe(false);
      expect(first.body.translation.steps[0].text).toMatch(/^Tome Furosemide 40 mg/);
      expect(spy).toHaveBeenCalledTimes(1);
      const second = await request(app.app).get(`/translation?lang=es&sum_id=${sumId}`);
      expect(second.body.fromCache).toBe(true);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(Object.keys((await app.ctx.summaries.get(sumId))?.translations ?? {})).toEqual(["es"]);
    } finally {
      await app.close();
    }
  });

  it("keeps the multipart form as an alias (patientId + text)", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).field("patientId", PATIENT_EN).field("text", exampleText("example-3-hfpef-cellulitis"));
    expect(res.status).toBe(202);
    expect(res.body.message).toBe("ingestion started");
    expect(res.body.sumId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    const empty = await t.provider(request(t.app).post("/ingest")).field("patientId", PATIENT_EN).field("text", "   \n ");
    expect(empty.status).toBe(400);
    expect(empty.body.error).toBe("empty_input");
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
    const { sumId, jobId } = await ingestText(t, text);
    const job = await t.provider(request(t.app).get(`/jobs/${jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.meta.model).toBe("rules");
    const summary = (await request(t.app).get(`/llm-sumary?sum-id=${sumId}`)).body["llm-summary"];
    expect(Object.keys(summary).sort()).toEqual([...AI_KEYS].sort());
    expect(summary.medications[0]).toMatchObject({ name: "Azithromycin", dose: "250 mg", status: "new" });
    expect(summary.medications.find((m: { name: string }) => m.name === "Lisinopril").status).toBe("stop");
    expect(summary.followUps[0].who).toBe("primary care");
    expect(summary.warnings[0]).toEqual({ text: "Chest pain.", tier: "call911" });
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
      const { sumId, jobId } = await ingestText(blocked, exampleText("example-1-chf"));
      const job = await blocked.provider(request(blocked.app).get(`/jobs/${jobId}`));
      expect(job.body.stage).toBe("needs_review");
      expect(job.body.verified).toBe(false);
      expect(job.body.safety.dropped).toEqual([expect.objectContaining({ name: "Metformin", missing: ["medication"] })]);
      expect(job.body.safety.reason).toBe("safety_check_failed dropped=1 unsupported=0");
      expect(blocked.mailer.sent).toHaveLength(0);
      expect((await blocked.ctx.summaries.get(sumId))?.status).toBe("needs_review");
      const res = await request(blocked.app).get(`/llm-sumary?sum-id=${sumId}`);
      expect(res.status).toBe(423);
      expect(res.body).toMatchObject({ statusCode: 423, error: "needs_review" });
      expect(JSON.stringify(res.body)).not.toContain("Metformin");
    } finally {
      await blocked.close();
    }
  });
});
