import type { AppContext } from "../context.js";
import { hashPrefix } from "../crypto/linkId.js";
import type { JobStage } from "../db/repos/jobs.js";
import type { LinkRecord } from "../db/repos/links.js";
import type { InputKind, RawDocument, StoredSummary, StoredTranslation } from "../docstore/documents.js";
import { SK } from "../docstore/types.js";
import { patientLinkEmail } from "../email/templates.js";
import { extractPdfText } from "../extract/pdf.js";
import { normalizeText } from "../extract/text.js";
import { resolveLanguages } from "./languages.js";
import { runPipeline, type PipelineRun } from "./runPipeline.js";

/** What POST /ingest hands to the pipeline. Kept in memory until the `raw` document exists. */
export interface PendingInput {
  /** Raw link id, needed only to build the patient URL for the email. */
  linkId: string;
  kind: InputKind;
  text?: string;
  file?: { buffer: Buffer; mimeType: string; fileName?: string };
}

export function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * The note's async steps after the 202, as a persisted stage machine:
 *   received -> extracting (pdf) | transcribing (audio) -> simplifying -> stored -> emailing -> done
 *                                                                            \-> needs_review (safety checks failed; no email yet)
 *   any stage --error--> failed
 * "simplifying" is lane 3 end to end: jargon to plain language -> safety checks -> translate into
 * the language the provider picked. The raw text, the LLM response and the translations land in
 * the document store (DynamoDB) encrypted, each with expiresAt = createdAt + 30 days.
 */
export async function runIngestJob(ctx: AppContext, jobId: string, pending?: PendingInput): Promise<void> {
  const { jobs, links, patients, audit, secureDocs, clock, log } = ctx;
  const job = await jobs.get(jobId);
  if (!job) return;
  const link = await links.getByHash(job.linkIdHash);
  if (!link) {
    await jobs.setStage(jobId, "failed", clock.nowIso(), "link_missing");
    return;
  }
  const lp = hashPrefix(job.linkIdHash);
  const setStage = async (stage: JobStage, error?: string) => {
    await jobs.setStage(jobId, stage, clock.nowIso(), error);
    await audit.append({ event: "job.stage", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { jobId, stage, ...(error ? { error } : {}) } });
    log.info({ jobId, link: lp, stage }, "job stage");
  };

  try {
    if (!link.encKey) throw new Error("link key is gone; cannot process");
    const key = link.encKey;
    const expiresAtEpoch = epochSeconds(link.expiresAt);

    // 1. The clinician text: from memory, or from the stored raw document (restart path).
    let raw: RawDocument | null = await secureDocs.getJson<RawDocument>({ linkIdHash: job.linkIdHash, sk: SK.raw, key }).catch(() => null);
    if (!raw) {
      if (!pending) throw new Error("restart_before_extraction: the input was lost when the process restarted");
      let text: string;
      let transcript: RawDocument["transcript"];
      if (pending.kind === "text") {
        text = normalizeText(pending.text ?? "");
      } else if (pending.kind === "pdf") {
        await setStage("extracting");
        const r = await extractPdfText(pending.file!.buffer);
        await jobs.mergeMeta(jobId, { pdfPages: r.pages, pdfEngine: r.engine }, clock.nowIso());
        text = r.text;
      } else {
        await setStage("transcribing");
        const r = await ctx.speechToText.transcribe({ audio: pending.file!.buffer, mimeType: pending.file!.mimeType, fileName: pending.file!.fileName, audioKey: link.audioKey ?? undefined });
        transcript = { provider: r.provider, jobName: r.jobName, latencyMs: r.latencyMs };
        await jobs.mergeMeta(jobId, { speechProvider: r.provider, transcribeJobName: r.jobName, transcribeMs: r.latencyMs }, clock.nowIso());
        text = normalizeText(r.transcript);
      }
      if (!text) throw new Error("empty_input_after_extraction");
      raw = { text, kind: pending.kind, linkId: pending.linkId, audioKey: link.audioKey ?? undefined, transcript };
      await secureDocs.putJson({ linkIdHash: job.linkIdHash, sk: SK.raw, key, keyVersion: link.keyVersion, value: raw, expiresAtEpochSeconds: expiresAtEpoch, createdAt: clock.nowIso() });
    }

    // 2. Lane 3: simplify -> safety checks -> translate into the picked language. Stored encrypted.
    await setStage("simplifying");
    const run = await synthesizeLink(ctx, link, raw.text, job.inputKind);
    await jobs.setSafety(jobId, run.safety, clock.nowIso());
    await jobs.mergeMeta(
      jobId,
      {
        provider: run.meta.provider,
        model: run.meta.model,
        usage: run.meta.usage,
        llmMs: run.meta.latencyMs,
        fixture: run.meta.fixture,
        sourceChars: run.meta.sourceChars,
        languages: Object.keys(run.perLanguage),
        skipped: run.meta.skipped,
      },
      clock.nowIso(),
    );
    await patients.setActiveLink(link.patientId, raw.linkId, link.expiresAt);
    await setStage("stored");

    // 3. Email the patient the link, only once the safety checks passed.
    if (run.verified) {
      await setStage("emailing");
      await emailPatientLink(ctx, link, raw.linkId);
      await setStage("done");
    } else {
      await audit.append({ event: "email.skipped", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { reason: "needs_review", safetyReason: run.safety.reason } });
      await setStage("needs_review");
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.error({ jobId, link: lp, err: { name: (err as Error)?.name, message } }, "job failed");
    await jobs.setStage(jobId, "failed", clock.nowIso(), message.slice(0, 500));
    await links.setStatus(job.linkIdHash, "failed").catch(() => undefined);
    await audit.append({ event: "job.stage", linkIdHash: job.linkIdHash, actor: "system", at: clock.nowIso(), details: { jobId, stage: "failed", error: message.slice(0, 200) } });
  }
}

/**
 * Runs lane 3 over the clinician text for a link and stores the result: `simplified` (the English
 * fixed JSON plus the safety result) and one `translation#<lang>` per produced language. Shared by
 * the ingest job and POST /synthesize { linkId }. Sets the link status (ready | needs_review) and
 * the languages the store now holds. Throws on a provider failure; the caller marks the job.
 */
export async function synthesizeLink(ctx: AppContext, link: LinkRecord, text: string, inputKind: InputKind, extraLanguages: string[] = []): Promise<PipelineRun> {
  const { links, secureDocs, clock } = ctx;
  if (!link.encKey) throw new Error("link key is gone; cannot synthesize");
  const key = link.encKey;
  const expiresAtEpoch = epochSeconds(link.expiresAt);
  const { languages } = resolveLanguages(link.language, extraLanguages);

  const run = await runPipeline(
    { rawText: text, languages },
    { speechToText: ctx.speechToText, simplifier: ctx.simplifier, translator: ctx.translator, log: ctx.log, now: () => clock.now() },
  );

  const createdAt = clock.nowIso();
  const stored: StoredSummary = {
    output: run.perLanguage.en,
    safety: run.safety,
    verified: run.verified,
    provider: run.meta.provider,
    model: run.meta.model,
    usage: run.meta.usage,
    fixture: run.meta.fixture,
    latencyMs: run.meta.latencyMs,
    sourceChars: run.meta.sourceChars,
    inputKind,
    createdAt,
  };
  await secureDocs.putJson({ linkIdHash: link.linkIdHash, sk: SK.simplified, key, keyVersion: link.keyVersion, value: stored, expiresAtEpochSeconds: expiresAtEpoch, createdAt });

  const produced = ["en"];
  for (const [lang, output] of Object.entries(run.perLanguage)) {
    if (lang === "en") continue;
    const translation: StoredTranslation = {
      output,
      check: run.safety.translations.find((t) => t.language === lang) ?? { language: lang, passed: true, issues: [] },
      provider: run.meta.provider,
      model: run.meta.model,
      createdAt,
    };
    await secureDocs.putJson({ linkIdHash: link.linkIdHash, sk: SK.translation(lang), key, keyVersion: link.keyVersion, value: translation, expiresAtEpochSeconds: expiresAtEpoch, createdAt });
    produced.push(lang);
  }
  // Translations made on demand earlier were made from the previous English: delete them, the
  // cache-first rule will rebuild them from the new English when a patient asks.
  for (const sk of await secureDocs.listKeys(link.linkIdHash)) {
    if (sk.startsWith(SK.translationPrefix) && !produced.includes(sk.slice(SK.translationPrefix.length))) {
      await secureDocs.delete(link.linkIdHash, sk);
    }
  }
  await links.setLanguages(link.linkIdHash, produced);
  await links.setStatus(link.linkIdHash, run.verified ? "ready" : "needs_review");
  ctx.log.info({ link: hashPrefix(link.linkIdHash), verified: run.verified, languages: produced, provider: run.meta.provider, model: run.meta.model, latencyMs: run.meta.latencyMs }, "lane 3 finished");
  return run;
}

/** "Email patient the link: your discharge summary is ready at this link." Console by default, SMTP, SES, or SQS + worker. */
export async function emailPatientLink(ctx: AppContext, link: LinkRecord, linkId: string): Promise<void> {
  const patient = await ctx.patients.getById(link.patientId);
  if (!patient) return;
  const mail = patientLinkEmail({ to: patient.email, link: ctx.patientUrl(linkId), expiresAt: link.expiresAt });
  const at = ctx.clock.nowIso();
  if (ctx.emailQueue) {
    const r = await ctx.emailQueue.enqueue({ ...mail, linkIdHash: link.linkIdHash, kind: "patient", enqueuedAt: at });
    await ctx.audit.append({ event: "email.queued", linkIdHash: link.linkIdHash, actor: "system", at, details: { kind: "patient", queue: "sqs", messageId: r.messageId } });
  } else {
    const sent = await ctx.mailer.send(mail);
    await ctx.audit.append({ event: "email.sent", linkIdHash: link.linkIdHash, actor: "system", at, details: { kind: "patient", transport: sent.transport, messageId: sent.messageId } });
  }
  await ctx.links.markEmailed(link.linkIdHash, at);
}
