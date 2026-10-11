import { Router } from "express";
import type { AppContext } from "../context.js";
import { AppError, badRequest } from "../errors.js";
import { resolveSummary, summaryBody, sumIdFromQuery } from "./linkAccess.js";
import { adaptSummary } from "../../../frontend/src/planAdapter.js";
import type { TranslationResult } from "../pipeline/translation.js";

/**
 * The team contract's `GET /translation?lang=&sum_id=` and its earlier spelling `GET /translate`.
 * Translates structured cards with the existing AI-Infra patient translation agent.
 */
export function translationRouter(ctx: AppContext): Router {
  const r = Router();
  const pending = new Map<string, Promise<TranslationResult>>();
  const cacheWrites = new Map<string, Promise<void>>();
  const translate = async (req: import("express").Request, res: import("express").Response) => {
    if (!ctx.translator) throw new AppError(501, "not_implemented", "Translation is not configured");
    const lang = req.query.lang;
    if (!["en", "es", "zh", "ar"].includes(String(lang))) throw badRequest("unsupported_language", "Choose en, es, zh or ar");
    const access = await resolveSummary(ctx, sumIdFromQuery(req.query));
    const body = await summaryBody(ctx, access, "translation");
    if (lang === "en") { res.json(body); return; }
    const plan = adaptSummary(body).record.byLang.en;
    if (!plan) throw new AppError(422, "unsupported_plan_format", "The generated plan cannot be translated into structured cards");
    const key = `${access.sumId}:${lang}`;
    let result = access.item.translations?.[String(lang)];
    if (!result) {
      let task = pending.get(key);
      if (!task) { task = ctx.translator.translate(plan, lang as "es" | "zh" | "ar"); pending.set(key, task); }
      try { result = await task; } finally { pending.delete(key); }
      // Check expiry and revision again: an update must never receive an older translation.
      // Serialize cache writes per plan so simultaneous language requests keep every result.
      const write = (cacheWrites.get(access.sumId) ?? Promise.resolve()).catch(() => {}).then(async () => {
        const latest = await resolveSummary(ctx, access.sumId);
        if (JSON.stringify(latest.llmSummary) !== JSON.stringify(access.llmSummary)) throw new AppError(409, "plan_changed", "This plan was updated. Select the language again.");
        await ctx.summaries.update(access.sumId, { translations: { ...latest.item.translations, [String(lang)]: result! } });
      });
      cacheWrites.set(access.sumId, write);
      try { await write; } finally { if (cacheWrites.get(access.sumId) === write) cacheWrites.delete(access.sumId); }
    }
    res.json({ ...body, language: lang, translatedPlan: result.plan, translationStatus: result.status, translationProblems: result.problems });
  };
  r.get("/translation", translate);
  r.get("/translate", translate);
  return r;
}
