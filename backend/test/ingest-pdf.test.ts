import { existsSync } from "node:fs";
import { join } from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decodePdfData, looksLikePdf, pdfToText } from "../src/extract/pdfToText.js";
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

  it("accepts the data: URL form and the helper", async () => {
    const { sumId, jobId } = await ingestPdf(t, examplePdf("example-1-chf"), { language: "es" });
    const job = await t.provider(request(t.app).get(`/jobs/${jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.languages).toEqual(["en", "es"]);
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

  it("accepts an audio clip through the multipart alias (diagram: audio/text + language), transcribes it offline, and simplifies the transcript", async () => {
    const res = await t
      .provider(request(t.app).post("/ingest"))
      .field("patientId", PATIENT_EN)
      .field("language", "es")
      .attach("audio", Buffer.from("RIFF....WAVEfmt fake audio bytes"), { filename: "dictation.wav", contentType: "audio/wav" });
    expect(res.status).toBe(202);
    const sumId = res.body.sumId as string;
    expect(existsSync(join(t.dir, "audio", `${sumId}.wav`))).toBe(true);
    await t.ctx.queue.onIdle();
    const job = await t.provider(request(t.app).get(`/jobs/${res.body.jobId}`));
    expect(job.body.stage).toBe("done");
    expect(job.body.inputKind).toBe("audio");
    expect(job.body.meta.speechProvider).toBe("offline");
    expect(job.body.languages).toEqual(["en", "es"]);
    const summary = await request(t.app).get(`/llm-sumary?sum-id=${sumId}`);
    expect(summary.status).toBe(200);
    expect(summary.body["llm-summary"].medications.map((m: { name: string }) => m.name)).toContain("Furosemide");
  });
});
