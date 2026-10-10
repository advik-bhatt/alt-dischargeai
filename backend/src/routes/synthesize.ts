import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { hashLinkId, hashPrefix, isLinkIdShaped } from "../crypto/linkId.js";
import type { RawDocument } from "../docstore/documents.js";
import { SK } from "../docstore/types.js";
import { AppError, badRequest, gone, notFound } from "../errors.js";
import { emailPatientLink, synthesizeLink } from "../pipeline/ingestJob.js";
import { normalizeLanguage, resolveLanguages } from "../pipeline/languages.js";
import { runPipeline } from "../pipeline/runPipeline.js";

const Body = z.object({
  linkId: z.string().trim().optional(),
  text: z.string().optional(),
  language: z.string().trim().optional(),
  languages: z.array(z.string().trim()).optional(),
});

/**
 * POST /synthesize (provider): the diagram's lane-3 entry point, so Person C can re-run the pipeline
 * after a prompt change without a new ingest.
 *   { text, language?, languages? }   runs jargon-to-plain-language -> safety checks -> translate over
 *                                     the given text and returns the fixed JSON per language (nothing stored)
 *   { linkId, language?, languages? } re-runs the pipeline over the raw text stored for the link,
 *                                     replaces the stored LLM response and translations, sets the link
 *                                     status (ready | needs_review) and emails the patient the link if
 *                                     it had not been sent yet
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

    if (body.linkId) {
      if (!isLinkIdShaped(body.linkId)) throw badRequest("invalid_link", "linkId must be the 22-character id returned by POST /ingest");
      const linkIdHash = hashLinkId(body.linkId);
      let link = await ctx.links.getByHash(linkIdHash);
      if (!link) throw notFound("link_not_found", "No link with that id");
      if (link.status === "purged") throw gone("link_purged", "This link was permanently deleted after 30 days");
      if (link.status === "expired" || !link.encKey || new Date(link.expiresAt).getTime() <= ctx.clock.now().getTime()) {
        throw gone("link_expired", "This link expired 30 days after it was created", { expiresAt: link.expiresAt });
      }
      const job = await ctx.jobs.latestForLink(linkIdHash);
      if (job && !["done", "needs_review", "failed"].includes(job.stage)) {
        throw new AppError(409, "job_in_progress", "The ingest job for this link is still running; follow GET /jobs/:jobId first", { jobId: job.id, stage: job.stage });
      }
      const raw = await ctx.secureDocs.getJson<RawDocument>({ linkIdHash, sk: SK.raw, key: link.encKey });
      if (!raw) throw new AppError(409, "no_source_text", "No clinician text is stored for this link yet (the ingest job stores it after extraction)");

      if (body.language) {
        await ctx.links.setLanguage(linkIdHash, normalizeLanguage(body.language)!);
        link = (await ctx.links.getByHash(linkIdHash))!;
      }
      const run = await synthesizeLink(ctx, link, raw.text, raw.kind, extras);
      let emailed = !!link.emailedAt;
      if (run.verified && !link.emailedAt) {
        await emailPatientLink(ctx, link, raw.linkId);
        emailed = true;
      }
      const after = (await ctx.links.getByHash(linkIdHash))!;
      await ctx.audit.append({ event: "synthesize.run", linkIdHash, actor: "provider", at: ctx.clock.nowIso(), details: { verified: run.verified, languages: after.languages, provider: run.meta.provider, model: run.meta.model, latencyMs: run.meta.latencyMs, emailed } });
      res.json({
        stored: true,
        linkRef: hashPrefix(linkIdHash),
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
    if (!text) throw badRequest("empty_input", "Provide { linkId } or { text, language(s) }");
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
