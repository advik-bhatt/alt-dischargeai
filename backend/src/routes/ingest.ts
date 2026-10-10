import { Router } from "express";
import { z } from "zod";
import { LINK_TTL_MS } from "../config.js";
import type { AppContext } from "../context.js";
import { newDataKey } from "../crypto/envelope.js";
import { hashLinkId, hashPrefix, newLinkId } from "../crypto/linkId.js";
import { audioKeyFor } from "../data/audio.js";
import type { RawDocument } from "../docstore/documents.js";
import { SK } from "../docstore/types.js";
import { badRequest, notFound } from "../errors.js";
import { isEmptyText, normalizeText } from "../extract/text.js";
import { looksLikePdf } from "../extract/pdf.js";
import { uploadMiddleware, type UploadedFiles } from "../middleware/upload.js";
import { ENGLISH, normalizeLanguage } from "../pipeline/languages.js";

const IngestFields = z.object({
  patientId: z.string().trim().min(1),
  text: z.string().optional(),
  language: z.string().trim().optional(),
});

/**
 * POST /ingest (provider, multipart): the note's main endpoint. `patientId` plus exactly one of
 * `text` | `file` (PDF) | `audio`, and the provider-picked `language` (name or BCP-47 code; defaults
 * to the patient's preferred language, then English). Stores the raw content in the document store,
 * generates the random link id, answers 202 "ingestion started" at once; the pipeline runs after.
 * The raw link id appears in this response, the email and the patient row only.
 */
export function ingestRouter(ctx: AppContext): Router {
  const r = Router();
  const upload = uploadMiddleware(ctx.config.MAX_UPLOAD_BYTES);

  r.post("/ingest", upload, async (req, res) => {
    const fields = IngestFields.parse(req.body ?? {});
    const files = (req.files ?? {}) as UploadedFiles;
    const pdf = files.file?.[0];
    const audio = files.audio?.[0];
    const text = fields.text ?? "";

    const provided = [!isEmptyText(text), !!pdf, !!audio].filter(Boolean).length;
    if (provided === 0) throw badRequest("empty_input", "Provide text, a PDF file, or an audio clip");
    if (provided > 1) throw badRequest("multiple_inputs", "Provide exactly one of text, file or audio");
    if (pdf && (pdf.size === 0 || !looksLikePdf(pdf.buffer))) throw badRequest("empty_input", "The uploaded file is not a readable PDF");
    if (audio && audio.size === 0) throw badRequest("empty_input", "The audio clip is empty");
    if (ctx.config.LLM_PROVIDER !== "offline" && text.length > 200_000) throw badRequest("input_too_long", "Text is limited to 200,000 characters");

    const patient = await ctx.patients.getById(fields.patientId);
    if (!patient) throw notFound("patient_not_found", "Unknown patientId");

    const pickedRaw = fields.language || patient.preferredLanguage || ENGLISH;
    const language = normalizeLanguage(pickedRaw);
    if (!language) throw badRequest("invalid_language", `"${pickedRaw}" is not a BCP-47 code or a language name`);

    const linkId = newLinkId();
    const linkIdHash = hashLinkId(linkId);
    const createdAt = ctx.clock.now();
    const expiresAt = new Date(createdAt.getTime() + LINK_TTL_MS);
    const kind = pdf ? "pdf" : audio ? "audio" : "text";
    const encKey = newDataKey();

    // Diagram: "store audio" first. The clip lands in the audio bucket (S3, SSE) under the link hash;
    // the lifecycle rule and the purge job both delete it on day 30.
    let audioKey: string | undefined;
    if (audio) {
      audioKey = audioKeyFor(linkIdHash, audio.mimetype, audio.originalname);
      await ctx.audio.put({ key: audioKey, body: audio.buffer, contentType: audio.mimetype });
    }

    await ctx.links.create({
      linkIdHash,
      patientId: patient.id,
      createdAt: createdAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      keyVersion: ctx.config.KEY_VERSION,
      encKey,
      language,
      audioKey,
    });
    // Pasted text is stored raw before the 202; PDF text and transcripts are stored once extracted.
    if (kind === "text") {
      const raw: RawDocument = { text: normalizeText(text), kind, linkId };
      await ctx.secureDocs.putJson({ linkIdHash, sk: SK.raw, key: encKey, keyVersion: ctx.config.KEY_VERSION, value: raw, expiresAtEpochSeconds: Math.floor(expiresAt.getTime() / 1000), createdAt: createdAt.toISOString() });
    }
    const job = await ctx.jobs.create({
      linkIdHash,
      inputKind: kind,
      now: ctx.clock.nowIso(),
      meta: { inputBytes: pdf?.size ?? audio?.size ?? Buffer.byteLength(text, "utf8"), mimeType: pdf?.mimetype ?? audio?.mimetype, language, ...(audioKey ? { audioStore: ctx.audio.name } : {}) },
    });
    await ctx.audit.append({ event: "link.created", linkIdHash, actor: "provider", at: ctx.clock.nowIso(), details: { patientId: patient.id, jobId: job.id, inputKind: kind, language, expiresAt: expiresAt.toISOString(), audioStored: !!audioKey } });
    ctx.log.info({ jobId: job.id, link: hashPrefix(linkIdHash), inputKind: kind, language }, "ingest accepted");

    res.status(202).json({
      status: "ingestion started",
      jobId: job.id,
      linkId,
      link: ctx.patientUrl(linkId),
      language,
      expiresAt: expiresAt.toISOString(),
      statusUrl: `/jobs/${job.id}`,
      stage: job.stage,
    });

    ctx.enqueueIngest(job.id, {
      linkId,
      kind,
      text: kind === "text" ? text : undefined,
      file: pdf
        ? { buffer: pdf.buffer, mimeType: pdf.mimetype, fileName: pdf.originalname }
        : audio
          ? { buffer: audio.buffer, mimeType: audio.mimetype, fileName: audio.originalname }
          : undefined,
    });
  });

  return r;
}
