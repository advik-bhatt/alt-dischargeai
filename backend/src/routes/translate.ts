import { Router } from "express";
import type { StoredTranslation } from "../agents/types.js";
import type { AppContext } from "../context.js";
import { SK } from "../docstore/types.js";
import { badRequest } from "../errors.js";
import { LANGUAGES, resolveLanguage } from "../languages.js";
import { checkTranslation } from "../verify/backtranslate.js";
import { resolveLink } from "./linkAccess.js";

function epochSeconds(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000);
}

/**
 * GET /translate?link=<linkId>&language=<name or code> (patient): cached translation if present,
 * else TranslatorAgent -> back-translation diff -> store -> return. GET /languages lists the options.
 */
export function translateRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/languages", (_req, res) => {
    res.json({ languages: LANGUAGES });
  });

  r.get("/translate", async (req, res) => {
    const langParam = typeof req.query.language === "string" ? req.query.language : "";
    const language = resolveLanguage(langParam);
    if (!language) throw badRequest("unsupported_language", `language must be one of GET /languages (got "${langParam}")`);
    const access = await resolveLink(ctx, req.query.link);
    const key = access.link.encKey!;
    const sk = SK.translation(language.code);

    const cached = await ctx.secureDocs.getJson<StoredTranslation>({ linkIdHash: access.linkIdHash, sk, key });
    if (cached) {
      await ctx.audit.append({ event: "translation.viewed", linkIdHash: access.linkIdHash, actor: "patient", at: ctx.clock.nowIso(), details: { language: language.code, fromCache: true } });
      res.json(render(cached, access, true));
      return;
    }

    const result = await ctx.translator.translate({ summary: access.stored.summary, language: language.code, languageName: language.name });
    const translation = { ...result.translation, readingLevel: "grade5" as const, language: language.code };
    const warnings = checkTranslation(access.stored.summary, translation, result.backTranslation);
    const stored: StoredTranslation = {
      translation,
      backTranslation: result.backTranslation,
      warnings,
      provider: result.provider,
      model: result.model,
      createdAt: ctx.clock.nowIso(),
    };
    await ctx.secureDocs.putJson({ linkIdHash: access.linkIdHash, sk, key, keyVersion: access.link.keyVersion, value: stored, expiresAtEpochSeconds: epochSeconds(access.expiresAt), createdAt: stored.createdAt });
    await ctx.audit.append({ event: "translation.created", linkIdHash: access.linkIdHash, actor: "patient", at: ctx.clock.nowIso(), details: { language: language.code, provider: result.provider, model: result.model, warningCount: warnings.length, latencyMs: result.latencyMs } });
    res.json(render(stored, access, false));
  });

  return r;
}

function render(stored: StoredTranslation, access: Awaited<ReturnType<typeof resolveLink>>, fromCache: boolean) {
  return {
    ...stored.translation,
    fromCache,
    expiresAt: access.expiresAt,
    daysLeft: access.daysLeft,
    warnings: [...access.stored.warnings, ...stored.warnings],
    needsReview: access.link.status === "needs_review",
    verification: {
      provider: stored.provider,
      model: stored.model,
      backTranslationCheck: stored.warnings.length ? "mismatches_found" : "passed",
      translatedAt: stored.createdAt,
    },
  };
}
