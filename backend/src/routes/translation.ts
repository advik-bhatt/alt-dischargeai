import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { languageFor, resolveSummary, sumIdFromQuery } from "./linkAccess.js";

/**
 * The team contract: `GET /translation?lang=...&sum_id=...`. Checks the summary item's
 * `translations` for the language and returns it when present; otherwise reads the llm-summary,
 * sends it to the translation agent with the language, saves the response under
 * `translations[lang]` and returns it. `fromCache` says which path answered. `lang` may be a
 * BCP-47 code or a language name (es, Spanish, zh, Mandarin, ar); `lang=en` returns the llm-summary.
 */
export function translationRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/translation", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const langParam = [q.lang, q.language].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    if (!langParam) throw badRequest("missing_language", "lang is required, e.g. /translation?lang=es&sum_id=<id> (a BCP-47 code or a language name)");
    const sumId = sumIdFromQuery(q);
    if (!sumId) throw badRequest("missing_sum_id", "sum_id is required, e.g. /translation?lang=es&sum_id=<id from POST /ingest>");
    const access = await resolveSummary(ctx, sumId);
    const t = await languageFor(ctx, access, langParam);
    res.json({
      "sum-id": access.sumId,
      sumId: access.sumId,
      lang: t.language,
      fromCache: t.fromCache,
      translation: t.output,
      availableLanguages: t.availableLanguages,
      expiresAt: access.expiresAt,
      daysLeft: access.daysLeft,
    });
  });
  return r;
}
