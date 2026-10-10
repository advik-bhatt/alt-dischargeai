import { Router } from "express";
import { z } from "zod";
import { LINK_TTL_MS } from "../config.js";
import type { AppContext } from "../context.js";
import { logRef, newSumId } from "../crypto/sumId.js";
import { audioKeyFor, pdfKeyFor } from "../data/objects.js";
import type { InputKind } from "../docstore/types.js";
import { AppError, badRequest, notFound } from "../errors.js";
import { decodePdfData, looksLikePdf } from "../extract/pdfToText.js";
import { isEmptyText, normalizeText } from "../extract/text.js";
import { uploadMiddleware, type UploadedFiles } from "../middleware/upload.js";
import { ENGLISH, normalizeLanguage } from "../pipeline/languages.js";

/** The team contract's body: { "data": ..., "type": "text" | "pdf", "patientID": ... } plus the optional language. */
/** The patients table's id may be a number (an INT column) or text; both arrive here as text. */
const PatientIdField = z.union([z.string().trim(), z.number().int().transform(String)]).optional();

const JsonBody = z.object({
  data: z.unknown().optional(),
  type: z.unknown().optional(),
  patientID: PatientIdField,
  patientId: PatientIdField,
  language: z.string().trim().optional(),
});

/** The earlier multipart form, kept as an alias: patientId + exactly one of text | file (PDF) | audio, plus language. */
const FormFields = z.object({
  patientId: z.string().trim().optional(),
  patientID: z.string().trim().optional(),
  text: z.string().optional(),
  language: z.string().trim().optional(),
});

interface Parsed {
  kind: InputKind;
  patientId: string;
  languageParam?: string;
  text?: string;
  file?: { buffer: Buffer; mimeType: string; fileName?: string };
}

/**
 * POST /ingest (provider): the team contract's main endpoint. JSON `{ data, type, patientID }`:
 * `type: "text"` ingests the text in `data`; `type: "pdf"` ingests the PDF in `data` (base64, with
 * or without a data: prefix), stores it in the PDF bucket and runs pdfToText; any other type fails
 * with 400 "type must be text or pdf". The random path (sumId) is generated, stored in activeLinks
 * and used as the DynamoDB uid; the response is immediate (202 "ingestion started") and the rest
 * runs asynchronously: LLM call, llm-summary + sum-id saved on the same item, email to the patient
 * and the caregiver. Multipart (patientId + text | file | audio) is accepted as an alias.
 */
export function ingestRouter(ctx: AppContext): Router {
  const r = Router();
  const upload = uploadMiddleware(ctx.config.MAX_UPLOAD_BYTES);

  r.post("/ingest", upload, async (req, res) => {
    const parsed = req.is("multipart/form-data") ? parseMultipart(req.body, (req.files ?? {}) as UploadedFiles) : parseJson(req.body);
    if (parsed.file && parsed.file.buffer.length > ctx.config.MAX_UPLOAD_BYTES) throw new AppError(413, "file_too_large", `The PDF is larger than ${ctx.config.MAX_UPLOAD_BYTES} bytes`);
    if (ctx.config.LLM_PROVIDER !== "offline" && (parsed.text?.length ?? 0) > 200_000) throw badRequest("input_too_long", "Text is limited to 200,000 characters");

    const patient = await ctx.patients.getById(parsed.patientId);
    if (!patient) throw notFound("patient_not_found", "Unknown patientID");

    const pickedRaw = parsed.languageParam || patient.preferredLanguage || ENGLISH;
    const language = normalizeLanguage(pickedRaw);
    if (!language) throw badRequest("invalid_language", `"${pickedRaw}" is not a BCP-47 code or a language name`);

    const sumId = newSumId();
    const createdAt = ctx.clock.now();
    const expiresAt = new Date(createdAt.getTime() + LINK_TTL_MS);
    const { kind } = parsed;

    // The PDF goes to the PDF bucket and the audio clip to the audio bucket before the 202, so the
    // bytes are durable; extraction and the LLM call run after the response.
    let pdfKey: string | undefined;
    let audioKey: string | undefined;
    if (kind === "pdf") {
      pdfKey = pdfKeyFor(sumId);
      await ctx.pdf.put({ key: pdfKey, body: parsed.file!.buffer, contentType: "application/pdf" });
    } else if (kind === "audio") {
      audioKey = audioKeyFor(sumId, parsed.file!.mimeType, parsed.file!.fileName);
      await ctx.audio.put({ key: audioKey, body: parsed.file!.buffer, contentType: parsed.file!.mimeType });
    }

    // One item per summary in the document store; raw-text is on it already for pasted text.
    await ctx.summaries.put({
      uid: sumId,
      "sum-id": sumId,
      patientID: patient.id,
      ...(kind === "text" ? { "raw-text": normalizeText(parsed.text ?? "") } : {}),
      translations: {},
      language,
      status: "processing",
      createdAt: createdAt.toISOString(),
      expiresAt: Math.floor(expiresAt.getTime() / 1000),
      inputKind: kind,
      ...(pdfKey ? { pdfKey } : {}),
      ...(audioKey ? { audioKey } : {}),
    });
    await ctx.activeLinks.create({ sumId, patientID: patient.id, createdAt: createdAt.toISOString(), expiresAt: expiresAt.toISOString(), language, pdfKey, audioKey });
    const job = await ctx.jobs.create({
      sumId,
      inputKind: kind,
      now: ctx.clock.nowIso(),
      meta: {
        inputBytes: parsed.file?.buffer.length ?? Buffer.byteLength(parsed.text ?? "", "utf8"),
        mimeType: parsed.file?.mimeType,
        language,
        ...(pdfKey ? { pdfStore: ctx.pdf.name } : {}),
        ...(audioKey ? { audioStore: ctx.audio.name } : {}),
      },
    });
    await ctx.audit.append({ event: "link.created", sumId, actor: "provider", at: ctx.clock.nowIso(), details: { patientId: patient.id, jobId: job.id, inputKind: kind, language, expiresAt: expiresAt.toISOString(), pdfStored: !!pdfKey, audioStored: !!audioKey } });
    ctx.log.info({ jobId: job.id, link: logRef(sumId), inputKind: kind, language }, "ingest accepted");

    res.status(202).json({
      statusCode: 202,
      message: "ingestion started",
      sumId,
      link: ctx.patientUrl(sumId),
      jobId: job.id,
      expiresAt: expiresAt.toISOString(),
      language,
      statusUrl: `/jobs/${job.id}`,
      stage: job.stage,
      linkId: sumId,
      status: "ingestion started",
    });

    ctx.enqueueIngest(job.id, { sumId, kind, text: kind === "text" ? parsed.text : undefined, file: parsed.file });
  });

  return r;
}

function parseJson(body: unknown): Parsed {
  const b = JsonBody.parse(body && typeof body === "object" ? body : {});
  const type = typeof b.type === "string" ? b.type.trim().toLowerCase() : "";
  if (type !== "text" && type !== "pdf") throw badRequest("invalid_type", "type must be text or pdf");
  const patientId = b.patientID || b.patientId;
  if (!patientId) throw badRequest("missing_patientID", "patientID is required");
  if (typeof b.data !== "string") throw badRequest("missing_data", type === "pdf" ? "data must be the PDF as a base64 string" : "data must be the discharge summary text");
  if (type === "text") {
    if (isEmptyText(b.data)) throw badRequest("empty_input", "data is empty");
    return { kind: "text", patientId, languageParam: b.language, text: b.data };
  }
  const buffer = decodePdfData(b.data);
  if (!buffer.length || !looksLikePdf(buffer)) throw badRequest("empty_input", "data is not a base64-encoded PDF");
  return { kind: "pdf", patientId, languageParam: b.language, file: { buffer, mimeType: "application/pdf", fileName: "upload.pdf" } };
}

function parseMultipart(body: unknown, files: UploadedFiles): Parsed {
  const fields = FormFields.parse(body ?? {});
  const patientId = fields.patientId || fields.patientID;
  if (!patientId) throw badRequest("missing_patientID", "patientId is required");
  const pdf = files.file?.[0];
  const audio = files.audio?.[0];
  const text = fields.text ?? "";
  const provided = [!isEmptyText(text), !!pdf, !!audio].filter(Boolean).length;
  if (provided === 0) throw badRequest("empty_input", "Provide text, a PDF file, or an audio clip");
  if (provided > 1) throw badRequest("multiple_inputs", "Provide exactly one of text, file or audio");
  if (pdf && (pdf.size === 0 || !looksLikePdf(pdf.buffer))) throw badRequest("empty_input", "The uploaded file is not a readable PDF");
  if (audio && audio.size === 0) throw badRequest("empty_input", "The audio clip is empty");
  if (pdf) return { kind: "pdf", patientId, languageParam: fields.language, file: { buffer: pdf.buffer, mimeType: pdf.mimetype, fileName: pdf.originalname } };
  if (audio) return { kind: "audio", patientId, languageParam: fields.language, file: { buffer: audio.buffer, mimeType: audio.mimetype, fileName: audio.originalname } };
  return { kind: "text", patientId, languageParam: fields.language, text };
}
