import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePdfData, looksLikePdf, pdfToText } from "../src/extract/pdfToText.js";
import { OfflineSimplifier } from "../src/pipeline/simplify.js";
import { PATIENT_EN, createTestApp, examplePdf, ingestPdf, type TestApp } from "./helpers.js";

describe("POST /ingest with type pdf (team contract), pdfToText, and the multipart and audio aliases", () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(() => t.close());

  it("pdfToText converts the Example 1 PDF fixture to text", async () => {
    const buf = examplePdf("example-1-chf");
    expect(looksLikePdf(buf)).toBe(true);
    const r = await pdfToText(buf);
    expect(r.pages).toBeGreaterThan(0);
    expect(r.engine).toMatch(/pdf-parse|pdfjs-dist/);
    expect(r.text).toContain("Furosemide 40 mg");
    expect(r.text).toContain("Amoxicillin-clavulanate 875/125 mg");
    await expect(pdfToText(Buffer.from("hello"))).rejects.toThrow(/not a PDF/);
  });

  it("pdfToText reads the README's inline curl sample line for line, and the README carries exactly that PDF", async () => {
    const buf = examplePdf("curl-sample");
    const r = await pdfToText(buf);
    expect(r).toEqual({
      text: "Discharge diagnosis: heart failure.\nNew medications:\n- Furosemide 40 mg by mouth once daily for swelling\nDischarge instructions:\n- Weigh yourself every morning\n- Follow up with cardiology within 1 week\nReturn precautions:\n- Call 911 for chest pain",
      pages: 1,
      engine: "pdf-parse",
    });
    const readme = readFileSync(join(import.meta.dirname, "..", "README.md"), "utf8");
    expect(readme).toContain(buf.toString("base64"));
  });

  it("the README's curl sample PDF goes through POST /ingest offline: extracted, verified, emailed", async () => {
    const { sumId, jobId } = await ingestPdf(t, examplePdf("curl-sample"));
    const job = await t.provider(request(t.app).get(`/jobs/${jobId}`));
    expect(job.body).toMatchObject({ stage: "done", verified: true, inputKind: "pdf" });
    expect(job.body.meta).toMatchObject({ pdfPages: 1, pdfEngine: "pdf-parse", pdfStore: "local" });
    expect((await t.ctx.summaries.get(sumId))?.["raw-text"]).toContain("Furosemide 40 mg by mouth once daily");
    const summary = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(summary.body["llm-summary"].medications).toEqual([{ name: "Furosemide", dose: "40 mg", howOften: "once a day by mouth", status: "new", why: "For swelling." }]);
  });

  it("decodes the PDF from base64 with or without a data: prefix, and rejects garbage", () => {
    const buf = examplePdf("example-1-chf");
    expect(decodePdfData(buf.toString("base64")).equals(buf)).toBe(true);
    expect(decodePdfData(`data:application/pdf;base64,${buf.toString("base64")}`).equals(buf)).toBe(true);
    expect(decodePdfData(buf.toString("base64").replace(/(.{76})/g, "$1\n")).equals(buf)).toBe(true);
    expect(decodePdfData("not base64!!").length).toBe(0);
    expect(looksLikePdf(decodePdfData(Buffer.from("plain text").toString("base64")))).toBe(false);
  });

  it("ingests { type: pdf, data: <base64> }: the PDF lands in the PDF store as <sumId>.pdf, the job extracts, the llm-summary is served", async () => {
    const res = await t.provider(request(t.app).post("/ingest")).send({ data: examplePdf("example-1-chf").toString("base64"), type: "pdf", patientID: PATIENT_EN });
    expect(res.status).toBe(202);
    expect(res.body.message).toBe("ingestion started");
    const sumId = res.body.sumId as string;
    // Stored before the 202 answered, under the sumId, in the PDF bucket's local twin.
    expect(existsSync(join(t.dir, "pdf", `${sumId}.pdf`))).toBe(true);
    expect((await t.ctx.pdf.get(`${sumId}.pdf`))?.contentType).toBe("application/pdf");
    expect((await t.ctx.activeLinks.getBySumId(sumId))?.pdfKey).toBe(`${sumId}.pdf`);
    expect((await t.ctx.summaries.get(sumId))?.pdfKey).toBe(`${sumId}.pdf`);
    const health = await request(t.app).get("/health");
    expect(health.body.providers.pdf).toMatchObject({ store: "local", requested: "local", bucket: "emrpdf-rh", fallbackReason: null });

    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.inputKind).toBe("pdf");
    expect(job.body.meta.pdfPages).toBeGreaterThan(0);
    expect(job.body.meta.pdfStore).toBe("local");
    const item = await t.ctx.summaries.get(sumId);
    expect(item?.["raw-text"]).toContain("Losartan 25 mg");
    expect(item?.meta?.pdfPages).toBeGreaterThan(0);
    const summary = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(summary.status).toBe(200);
    expect(summary.body["llm-summary"].medications.some((m: { name: string }) => m.name === "Losartan")).toBe(true);
  });

  it("turns the PDF into text BEFORE the answer and before the LLM: the extracted text is on the item at the 202 and is exactly what the LLM receives", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const base = new OfflineSimplifier();
    const seen: string[] = [];
    const held = {
      name: "held",
      async simplify(input: { text: string }) {
        seen.push(input.text);
        await gate;
        return base.simplify(input);
      },
    };
    const app = await createTestApp({ simplifier: held });
    try {
      const res = await app.provider(request(app.app).post("/ingest")).send({ data: examplePdf("example-1-chf").toString("base64"), type: "pdf", patientID: PATIENT_EN });
      expect(res.status).toBe(202);
      const sumId = res.body.sumId as string;
      // The LLM has not answered (it is held), yet the record already carries the extracted text and the PDF is stored.
      const item = await app.ctx.summaries.get(sumId);
      const extracted = (await pdfToText(examplePdf("example-1-chf"))).text;
      expect(item?.["raw-text"]).toBe(extracted);
      expect(item?.status).toBe("processing");
      expect(item?.["llm-summary"]).toBeUndefined();
      expect(item?.meta).toMatchObject({ pdfEngine: expect.stringMatching(/pdf-parse|pdfjs-dist/), pdfPages: expect.any(Number) });
      expect((await app.ctx.activeLinks.getBySumId(sumId))?.pdfKey).toBe(`${sumId}.pdf`);
      expect((await app.provider(request(app.app).get(`/jobs/${res.body.jobId}`))).body.meta).toMatchObject({ pdfPages: expect.any(Number), pdfEngine: expect.any(String) });
      release();
      await app.ctx.queue.onIdle();
      // The text sent to the LLM is the text that was saved: one string, not a second extraction.
      expect(seen).toEqual([extracted]);
      expect((await app.ctx.summaries.get(sumId))?.["raw-text"]).toBe(extracted);
      expect((await app.provider(request(app.app).get(`/jobs/${res.body.jobId}`))).body.stage).toBe("done");
    } finally {
      release();
      await app.close();
    }
  });

  it("refuses a PDF it cannot read with 400 before saving anything: no item, no link, no stored file, no job", async () => {
    const app = await createTestApp();
    try {
      const count = async (sql: string) => Number((await app.ctx.db.get<{ n: number }>(sql))?.n);
      const files = () => (existsSync(join(app.dir, "pdf")) ? readdirSync(join(app.dir, "pdf")).length : 0);
      const before = { links: await count("SELECT COUNT(*) AS n FROM activeLinks"), jobs: await count("SELECT COUNT(*) AS n FROM jobs"), files: files() };
      const corrupt = Buffer.from("%PDF-1.4\nthis is not a pdf body\n%%EOF\n");
      const res = await app.provider(request(app.app).post("/ingest")).send({ data: corrupt.toString("base64"), type: "pdf", patientID: PATIENT_EN });
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ statusCode: 400, error: "unreadable_pdf" });
      expect(res.body.message).toMatch(/^The PDF could not be turned into text: /);
      expect({ links: await count("SELECT COUNT(*) AS n FROM activeLinks"), jobs: await count("SELECT COUNT(*) AS n FROM jobs"), files: files() }).toEqual(before);
      expect(app.mailer.sent).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("a PDF job that was interrupted resumes from the text on the item after a restart (no PDF bytes needed); an audio job cannot, and says so", async () => {
    let calls = 0;
    const base = new OfflineSimplifier();
    const crashing = {
      name: "crashing",
      async simplify(input: { text: string }) {
        calls += 1;
        if (calls === 1) throw new Error("simulated crash");
        return base.simplify(input);
      },
    };
    const app = await createTestApp({ simplifier: crashing });
    try {
      const { sumId, jobId } = await ingestPdf(app, examplePdf("example-1-chf"));
      expect((await app.provider(request(app.app).get(`/jobs/${jobId}`))).body.stage).toBe("failed");
      // Put it back to what a restart finds: an unfinished job, and no in-memory input handed over.
      await app.ctx.jobs.setStage(jobId, "simplifying", app.ctx.clock.nowIso());
      await app.ctx.activeLinks.setStatus(sumId, "pending");
      app.ctx.enqueueIngest(jobId);
      await app.ctx.queue.onIdle();
      const job = await app.provider(request(app.app).get(`/jobs/${jobId}`));
      expect(job.body.stage).toBe("done");
      expect(calls).toBe(2);
      expect((await request(app.app).get(`/llm-sumary?sum-id=${sumId}`)).status).toBe(200);

      // Audio has no text on the item until it is transcribed, and the bytes are gone with the process.
      const audio = await app.provider(request(app.app).post("/ingest")).field("patientId", PATIENT_EN).attach("audio", Buffer.from("RIFF....WAVEfmt fake audio bytes"), { filename: "d.wav", contentType: "audio/wav" });
      await app.ctx.queue.onIdle();
      const audioJob = audio.body.jobId as string;
      await app.ctx.summaries.update(audio.body.sumId, { "raw-text": "" });
      await app.ctx.jobs.setStage(audioJob, "transcribing", app.ctx.clock.nowIso());
      app.ctx.enqueueIngest(audioJob);
      await app.ctx.queue.onIdle();
      const failed = await app.provider(request(app.app).get(`/jobs/${audioJob}`));
      expect(failed.body.stage).toBe("failed");
      expect(failed.body.error).toMatch(/^restart_before_transcription/);
    } finally {
      await app.close();
    }
  });

  it("accepts the data: URL form and the helper", async () => {
    const { sumId, jobId } = await ingestPdf(t, examplePdf("example-1-chf"));
    const job = await t.provider(request(t.app).get(`/jobs/${jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.languages).toEqual(["en"]);
    const res = await t.provider(request(t.app).post("/ingest")).send({ data: `data:application/pdf;base64,${examplePdf("example-1-chf").toString("base64")}`, type: "pdf", patientID: PATIENT_EN });
    expect(res.status).toBe(202);
    expect(res.body.sumId).not.toBe(sumId);
    await t.ctx.queue.onIdle();
  });

  it("rejects data that is not a PDF with 400 empty_input, and an oversized PDF with 413", async () => {
    const bad = await t.provider(request(t.app).post("/ingest")).send({ data: Buffer.from("hello").toString("base64"), type: "pdf", patientID: PATIENT_EN });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ statusCode: 400, error: "empty_input" });
    const notString = await t.provider(request(t.app).post("/ingest")).send({ data: 42, type: "pdf", patientID: PATIENT_EN });
    expect(notString.body).toMatchObject({ statusCode: 400, error: "missing_data" });
    const small = await createTestApp({ env: { MAX_UPLOAD_BYTES: "2048" } });
    try {
      const big = await small.provider(request(small.app).post("/ingest")).send({ data: examplePdf("example-1-chf").toString("base64"), type: "pdf", patientID: PATIENT_EN });
      expect(big.status).toBe(413);
      expect(big.body.statusCode).toBe(413);
    } finally {
      await small.close();
    }
  });

  it("keeps the multipart file upload as an alias and rejects a non-PDF file", async () => {
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", PATIENT_EN)
      .attach("file", examplePdf("example-1-chf"), { filename: "example-1-chf.pdf", contentType: "application/pdf" });
    expect(res.status).toBe(202);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.inputKind).toBe("pdf");
    const bad = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", PATIENT_EN)
      .attach("file", Buffer.from("hello"), { filename: "x.pdf", contentType: "application/pdf" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("empty_input");
  });

  it("accepts an audio clip through the multipart alias (diagram), transcribes it in the background offline, saves the transcript as raw-text, and simplifies it", async () => {
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", PATIENT_EN)
      .attach("audio", Buffer.from("RIFF....WAVEfmt fake audio bytes"), { filename: "dictation.wav", contentType: "audio/wav" });
    expect(res.status).toBe(202);
    const sumId = res.body.sumId as string;
    expect(existsSync(join(t.dir, "audio", `${sumId}.wav`))).toBe(true);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.inputKind).toBe("audio");
    expect(job.body.meta.speechProvider).toBe("offline");
    expect(job.body.languages).toEqual(["en"]);
    // Audio is the one input whose text does not exist before the answer; once transcribed it is saved like any other.
    expect((await t.ctx.summaries.get(sumId))?.["raw-text"]).toContain("Furosemide");
    const summary = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(summary.status).toBe(200);
    expect(summary.body["llm-summary"].medications.map((m: { name: string }) => m.name)).toContain("Furosemide");
  });
});
