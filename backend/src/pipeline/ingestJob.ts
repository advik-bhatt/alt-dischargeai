import type { AiOutput } from "../contracts/aiOutput.js";
import type { AppContext } from "../context.js";
import { logRef } from "../crypto/sumId.js";
import type { ActiveLink } from "../db/repos/activeLinks.js";
import type { JobStage } from "../db/repos/jobs.js";
import type { InputKind, SummaryMeta } from "../docstore/types.js";
import { caregiverLinkEmail, patientLinkEmail, type LinkEmail } from "../email/templates.js";
import { pdfToText } from "../extract/pdfToText.js";
import { normalizeText } from "../extract/text.js";
import { resolveLanguages } from "./languages.js";
import { runPipeline, type PipelineRun } from "./runPipeline.js";

/** What POST /ingest hands to the pipeline. Kept in memory until `raw-text` exists on the item. */
export interface PendingInput {
  sumId: string;
  kind: InputKind;
  text?: string;
  file?: { buffer: Buffer; mimeType: string; fileName?: string };
}

export function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * The team contract's async steps after the 202, as a persisted stage machine:
 *   received -> extracting (pdf: pdfToText) | transcribing (audio) -> simplifying -> stored -> emailing -> done
 *                                                                                    \-> needs_review (safety checks failed; no email yet)
 *   any stage --error--> failed
 * "simplifying" is lane 3 end to end: jargon to plain language -> safety checks -> translate into
 * the language the provider picked. The raw text goes on the summary item as `raw-text`; when the
 * LLM returns, `llm-summary` and `sum-id` are saved on the same item; then the link is emailed to
 * the patient and to the caregiverEmail.
 */
export async function runIngestJob(ctx: AppContext, jobId: string, pending?: PendingInput): Promise<void> {
  const { jobs, activeLinks, summaries, audit, clock, log } = ctx;
  const job = await jobs.get(jobId);
  if (!job) return;
  const link = await activeLinks.getBySumId(job.sumId);
  if (!link) {
    await jobs.setStage(jobId, "failed", clock.nowIso(), "link_missing");
    return;
  }
  const ref = logRef(job.sumId);
  const setStage = async (stage: JobStage, error?: string) => {
    await jobs.setStage(jobId, stage, clock.nowIso(), error);
    await audit.append({ event: "job.stage", sumId: job.sumId, actor: "system", at: clock.nowIso(), details: { jobId, stage, ...(error ? { error } : {}) } });
    log.info({ jobId, link: ref, stage }, "job stage");
  };

  try {
    const item = await summaries.get(job.sumId);
    if (!item) throw new Error("summary item missing from the document store");

    // 1. The clinician text: already on the item (pasted text, or a restart), or extracted now.
    let text = item["raw-text"] ?? "";
    if (!text) {
      if (!pending) throw new Error("restart_before_extraction: the input was lost when the process restarted");
      const meta: SummaryMeta = { ...(item.meta ?? {}) };
      if (pending.kind === "text") {
        text = normalizeText(pending.text ?? "");
      } else if (pending.kind === "pdf") {
        await setStage("extracting");
        const r = await pdfToText(pending.file!.buffer);
        meta.pdfPages = r.pages;
        meta.pdfEngine = r.engine;
        await jobs.mergeMeta(jobId, { pdfPages: r.pages, pdfEngine: r.engine }, clock.nowIso());
        text = r.text;
      } else {
        await setStage("transcribing");
        // Transcribe Medical reads the clip from the bucket by key; with the local twin it gets the bytes.
        const r = await ctx.speechToText.transcribe({ audio: pending.file!.buffer, mimeType: pending.file!.mimeType, fileName: pending.file!.fileName, audioKey: ctx.audio.name === "s3" ? (link.audioKey ?? undefined) : undefined });
        meta.transcript = { provider: r.provider, jobName: r.jobName, latencyMs: r.latencyMs };
        await jobs.mergeMeta(jobId, { speechProvider: r.provider, transcribeJobName: r.jobName, transcribeMs: r.latencyMs }, clock.nowIso());
        text = normalizeText(r.transcript);
      }
      if (!text) throw new Error("empty_input_after_extraction");
      await summaries.update(job.sumId, { "raw-text": text, meta });
    }

    // 2. Lane 3: simplify -> safety checks -> translate into the picked language. Saved on the item.
    await setStage("simplifying");
    const run = await synthesizeLink(ctx, link, text, job.inputKind);
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
    await setStage("stored");

    // 3. Email the link to the patient and the caregiver, only once the safety checks passed.
    if (run.verified) {
      await setStage("emailing");
      await emailLinks(ctx, link);
      await setStage("done");
    } else {
      await audit.append({ event: "email.skipped", sumId: job.sumId, actor: "system", at: clock.nowIso(), details: { reason: "needs_review", safetyReason: run.safety.reason } });
      await setStage("needs_review");
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err);
    log.error({ jobId, link: ref, err: { name: (err as Error)?.name, message } }, "job failed");
    await jobs.setStage(jobId, "failed", clock.nowIso(), message.slice(0, 500));
    await activeLinks.setStatus(job.sumId, "failed").catch(() => undefined);
    await summaries.update(job.sumId, { status: "failed" }).catch(() => undefined);
    await audit.append({ event: "job.stage", sumId: job.sumId, actor: "system", at: clock.nowIso(), details: { jobId, stage: "failed", error: message.slice(0, 200) } });
  }
}

/**
 * Runs lane 3 over the clinician text for a link and saves the result on the summary item:
 * `llm-summary` (the English fixed JSON), `sum-id`, `translations` (one entry per produced
 * language), `status`, the safety result and the run metadata. Shared by the ingest job and
 * POST /synthesize { sumId }. Translations made on demand earlier were made from the previous
 * English, so the map is replaced; the cache-first rule rebuilds them when a patient asks.
 * Throws on a provider failure; the caller marks the job.
 */
export async function synthesizeLink(ctx: AppContext, link: ActiveLink, text: string, inputKind: InputKind, extraLanguages: string[] = []): Promise<PipelineRun> {
  const { activeLinks, summaries, clock } = ctx;
  const { languages } = resolveLanguages(link.language, extraLanguages);

  const run = await runPipeline(
    { rawText: text, languages },
    { speechToText: ctx.speechToText, simplifier: ctx.simplifier, translator: ctx.translator, log: ctx.log, now: () => clock.now() },
  );

  const translations: Record<string, AiOutput> = {};
  for (const [lang, output] of Object.entries(run.perLanguage)) if (lang !== "en") translations[lang] = output;
  const current = await summaries.get(link.sumId);
  const status = run.verified ? "ready" : "needs_review";
  await summaries.update(link.sumId, {
    "llm-summary": run.perLanguage.en,
    "sum-id": link.sumId,
    translations,
    status,
    language: link.language,
    inputKind,
    safety: run.safety,
    meta: { ...(current?.meta ?? {}), provider: run.meta.provider, model: run.meta.model, usage: run.meta.usage, fixture: run.meta.fixture, latencyMs: run.meta.latencyMs, sourceChars: run.meta.sourceChars, skipped: run.meta.skipped },
  });
  const produced = ["en", ...Object.keys(translations)];
  await activeLinks.setLanguages(link.sumId, produced);
  await activeLinks.setStatus(link.sumId, status);
  ctx.log.info({ link: logRef(link.sumId), verified: run.verified, languages: produced, provider: run.meta.provider, model: run.meta.model, latencyMs: run.meta.latencyMs }, "lane 3 finished");
  return run;
}

/**
 * The team contract's step 5: "Send email w/ link to the patient at both email, and caregiverEmail".
 * Console by default, SMTP, SES, or SQS + worker. Returns who was sent to.
 */
export async function emailLinks(ctx: AppContext, link: ActiveLink): Promise<{ patient: boolean; caregiver: boolean }> {
  const patient = await ctx.patients.getById(link.patientID);
  if (!patient) return { patient: false, caregiver: false };
  const url = ctx.patientUrl(link.sumId);
  const deliveries: { kind: "patient" | "caregiver"; mail: LinkEmail }[] = [];
  if (patient.email) deliveries.push({ kind: "patient", mail: patientLinkEmail({ to: patient.email, link: url, expiresAt: link.expiresAt }) });
  else await ctx.audit.append({ event: "email.skipped", sumId: link.sumId, actor: "system", at: ctx.clock.nowIso(), details: { kind: "patient", reason: "no_email_on_patient_row" } });
  if (patient.caregiverEmail) deliveries.push({ kind: "caregiver", mail: caregiverLinkEmail({ to: patient.caregiverEmail, link: url, expiresAt: link.expiresAt }) });

  for (const { kind, mail } of deliveries) {
    const at = ctx.clock.nowIso();
    if (ctx.emailQueue) {
      const r = await ctx.emailQueue.enqueue({ ...mail, sumId: link.sumId, kind, enqueuedAt: at });
      await ctx.audit.append({ event: "email.queued", sumId: link.sumId, actor: "system", at, details: { kind, queue: "sqs", messageId: r.messageId } });
    } else {
      const sent = await ctx.mailer.send(mail);
      await ctx.audit.append({ event: "email.sent", sumId: link.sumId, actor: "system", at, details: { kind, transport: sent.transport, messageId: sent.messageId } });
    }
  }
  if (deliveries.length) await ctx.activeLinks.markEmailed(link.sumId, ctx.clock.nowIso());
  return { patient: deliveries.some((d) => d.kind === "patient"), caregiver: deliveries.some((d) => d.kind === "caregiver") };
}
