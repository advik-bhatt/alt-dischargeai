import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { isSumIdShaped, logRef } from "../crypto/sumId.js";
import { AppError, badRequest, gone, notFound } from "../errors.js";
import { emailLinks, synthesizeLink } from "../pipeline/ingestJob.js";
import { normalizeLanguage, resolveLanguages } from "../pipeline/languages.js";
import { runPipeline } from "../pipeline/runPipeline.js";

const Body = z.object({
  sumId: z.string().trim().optional(),
  linkId: z.string().trim().optional(),
  text: z.string().optional(),
  language: z.string().trim().optional(),
  languages: z.array(z.string().trim()).optional(),
});

/**
 * POST /synthesize (provider): the diagram's lane-3 entry point, so the teammate who owns the LLM
 * agent can re-run the pipeline after a prompt change without a new ingest.
 *   { text, language?, languages? }   runs jargon-to-plain-language -> safety checks over the given text
 *                                     and returns the fixed JSON (nothing stored); translates only into
 *                                     the languages named in the request
 *   { sumId, language?, languages? }  re-runs the LLM step over the raw-text stored on the summary item,
 *                                     replaces llm-summary, clears translations made from the old
 *                                     English, sets the status (ready | needs_review) and emails the
 *                                     patient and caregiver if the link had not been sent yet
 *                                     (`linkId` is accepted for `sumId`)
 * Ingestion itself never translates; this route does so only when the caller names languages.
 * Safety-check results come back under `safety`, next to the per-language JSON, never inside it.
 */
export function synthesizeRouter(ctx: AppContext): Router {
  const r = Router();

  r.post("/synthesize", async (req, res) => {
    const body = Body.parse(req.body ?? {});
    const extras = body.languages ?? [];
    for (const l of [body.language, ...extras]) {
      if (l && !normalizeLanguage(l)) throw badRequest("invalid_language", `"${l}" is not a BCP-47 code or a language name`);
    }

    const sumId = body.sumId ?? body.linkId;
    if (sumId) {
      if (!isSumIdShaped(sumId)) throw badRequest("invalid_link", "sumId must be the 22-character id returned by POST /ingest");
      const link = await ctx.activeLinks.getBySumId(sumId);
      if (!link) throw notFound("link_not_found", "No summary with that id");
      if (link.status === "purged") throw gone("link_purged", "This summary was permanently deleted after 30 days");
      if (link.status === "expired" || new Date(link.expiresAt).getTime() <= ctx.clock.now().getTime()) {
        throw gone("link_expired", "This summary expired 30 days after it was created", { expiresAt: link.expiresAt });
      }
      const job = await ctx.jobs.latestForLink(sumId);
      if (job && !["done", "needs_review", "failed"].includes(job.stage)) {
        throw new AppError(409, "job_in_progress", "The ingest job for this summary is still running; follow GET /jobs/:jobId first", { jobId: job.id, stage: job.stage });
      }
      const item = await ctx.summaries.get(sumId);
      const text = item?.["raw-text"];
      if (!item || !text) throw new AppError(409, "no_source_text", "No clinician text is stored for this summary yet (an audio ingest stores it after transcription)");

      const requested = resolveLanguages(body.language, extras).languages;
      const run = await synthesizeLink(ctx, link, text, item.inputKind, requested);
      let emailed = !!link.emailedAt;
      if (run.verified && !link.emailedAt) {
        await emailLinks(ctx, link);
        emailed = true;
      }
      const after = (await ctx.activeLinks.getBySumId(sumId))!;
      await ctx.audit.append({ event: "synthesize.run", sumId, actor: "provider", at: ctx.clock.nowIso(), details: { verified: run.verified, languages: after.languages, provider: run.meta.provider, model: run.meta.model, latencyMs: run.meta.latencyMs, emailed } });
      res.json({
        stored: true,
        sumId,
        linkRef: logRef(sumId),
        status: after.status,
        verified: run.verified,
        emailed,
        languages: after.languages,
        perLanguage: run.perLanguage,
        safety: run.safety,
        meta: run.meta,
        expiresAt: after.expiresAt,
      });
      return;
    }

    const text = (body.text ?? "").trim();
    if (!text) throw badRequest("empty_input", "Provide { sumId } or { text, language(s) }");
    const { languages } = resolveLanguages(body.language, extras);
    const run = await runPipeline({ rawText: text, languages }, { speechToText: ctx.speechToText, simplifier: ctx.simplifier, translator: ctx.translator, log: ctx.log, now: () => ctx.clock.now() });
    res.json({
      stored: false,
      status: run.verified ? "ready" : "needs_review",
      verified: run.verified,
      languages: Object.keys(run.perLanguage),
      perLanguage: run.perLanguage,
      safety: run.safety,
      meta: run.meta,
    });
  });

  return r;
}
