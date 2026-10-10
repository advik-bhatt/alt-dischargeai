import type { AiOutput } from "../contracts/aiOutput.js";
import type { AppContext } from "../context.js";
import { isSumIdShaped, logRef } from "../crypto/sumId.js";
import type { ActiveLink } from "../db/repos/activeLinks.js";
import { languagesOf, type SummaryItem } from "../docstore/types.js";
import { AppError, badRequest, gone, notFound, tooEarly } from "../errors.js";
import { ENGLISH, languageName, normalizeLanguage } from "../pipeline/languages.js";
import { checkTranslation } from "../pipeline/safetyChecks.js";

export interface SummaryAccess {
  sumId: string;
  link: ActiveLink;
  item: SummaryItem;
  /** The LLM response, the English fixed JSON. */
  english: AiOutput;
  expiresAt: string;
  daysLeft: number;
}

/** The summary id from any of the spellings the routes accept: sum-id (contract), sum_id (contract), sumId, link, token. */
export function sumIdFromQuery(query: Record<string, unknown>): unknown {
  for (const key of ["sum-id", "sum_id", "sumId", "link", "token"]) {
    const v = query[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

/**
 * Every patient read goes through here. Order matters:
 *   400 malformed id -> 404 unknown -> 410 purged / expired (checked against the app clock at read
 *   time, independently of the purge job) -> 425 still processing -> 423 needs clinician review ->
 *   500 failed -> the item with its llm-summary.
 * A link found expired here is marked expired and audited at once; the purge job deletes its data next.
 */
export async function resolveSummary(ctx: AppContext, sumIdParam: unknown): Promise<SummaryAccess> {
  if (!isSumIdShaped(sumIdParam)) throw badRequest("invalid_link", "sum-id must be the 22-character id from the link (sum-id, sum_id or link)");
  const sumId = sumIdParam;
  const link = await ctx.activeLinks.getBySumId(sumId);
  if (!link) throw notFound("link_not_found", "No discharge summary exists for this id");

  const now = ctx.clock.now();
  const expiresAt = new Date(link.expiresAt);
  if (link.status === "purged") {
    throw gone("link_purged", "This discharge summary was permanently deleted 30 days after it was created", { expiresAt: link.expiresAt });
  }
  if (link.status === "expired" || expiresAt.getTime() <= now.getTime()) {
    if (link.status !== "expired") {
      await ctx.activeLinks.setStatus(sumId, "expired");
      await ctx.audit.append({ event: "link.expired", sumId, actor: "system", at: ctx.clock.nowIso(), details: { detectedAt: "read" } });
    }
    throw gone("link_expired", "This discharge summary expired 30 days after it was created", { expiresAt: link.expiresAt });
  }

  const job = await ctx.jobs.latestForLink(sumId);
  if (link.status === "pending" || (job && !["done", "needs_review", "failed"].includes(job.stage) && link.status !== "ready")) {
    throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "received", jobId: job?.id, expiresAt: link.expiresAt });
  }
  if (link.status === "needs_review") {
    throw new AppError(423, "needs_review", "Your care team is reviewing this summary before it can be shown", { expiresAt: link.expiresAt });
  }
  if (link.status === "failed") {
    throw new AppError(500, "processing_failed", "The summary could not be prepared", { expiresAt: link.expiresAt });
  }

  const item = await ctx.summaries.get(sumId);
  const english = item?.["llm-summary"];
  if (!item || !english) throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "stored", expiresAt: link.expiresAt });

  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
  return { sumId, link, item, english, expiresAt: link.expiresAt, daysLeft };
}

export interface LanguageResult {
  language: string;
  output: AiOutput;
  fromCache: boolean;
  availableLanguages: string[];
}

/**
 * The team contract's GET /translation in one place: checks the item's `translations` for the
 * language first and returns it; on a miss reads the llm-summary (the same item the GET /llm-sumary
 * path reads), sends it to the translation agent with the language, waits, checks the result
 * (names, doses and numbers verbatim), saves it under `translations[lang]` and returns it.
 */
export async function languageFor(ctx: AppContext, access: SummaryAccess, languageParam: unknown): Promise<LanguageResult> {
  const requested = typeof languageParam === "string" && languageParam.trim() ? normalizeLanguage(languageParam) : ENGLISH;
  if (!requested) throw badRequest("invalid_language", `lang must be a BCP-47 code or a language name (got "${String(languageParam)}")`);
  const { sumId, item, english } = access;
  const now = ctx.clock.nowIso();
  await ctx.activeLinks.touchViewed(sumId, now);
  const available = languagesOf(item);

  if (requested === ENGLISH) {
    await ctx.audit.append({ event: "summary.viewed", sumId, actor: "patient", at: now, details: { language: ENGLISH, daysLeft: access.daysLeft } });
    return { language: ENGLISH, output: english, fromCache: true, availableLanguages: available };
  }

  const base = requested.split("-")[0];
  for (const lang of [...new Set([requested, base])]) {
    const cached = item.translations?.[lang];
    if (cached) {
      await ctx.audit.append({ event: "translation.viewed", sumId, actor: "patient", at: now, details: { language: lang, fromCache: true } });
      return { language: lang, output: cached, fromCache: true, availableLanguages: available };
    }
  }

  let result: Awaited<ReturnType<AppContext["translator"]["translate"]>>;
  try {
    result = await ctx.translator.translate({ english, language: requested, languageName: languageName(requested) });
  } catch (err) {
    ctx.log.warn({ link: logRef(sumId), language: requested, err: { message: (err as Error).message } }, "translation agent failed");
    throw new AppError(502, "translation_failed", "The translation could not be produced right now; the English summary is still available", { language: requested });
  }
  const output = { ...result.output, language: requested };
  const check = checkTranslation(english, output);
  if (!check.passed) {
    await ctx.audit.append({ event: "translation.created", sumId, actor: "patient", at: now, details: { language: requested, provider: result.provider, model: result.model, rejected: true, issues: check.issues } });
    throw new AppError(422, "translation_rejected", "The translation changed a medication name, dose or number and was not accepted", { language: requested, issues: check.issues });
  }
  await ctx.summaries.setTranslation(sumId, requested, output);
  const availableLanguages = await ctx.activeLinks.addLanguage(sumId, requested);
  await ctx.audit.append({ event: "translation.created", sumId, actor: "patient", at: now, details: { language: requested, provider: result.provider, model: result.model, latencyMs: result.latencyMs } });
  return { language: requested, output, fromCache: false, availableLanguages };
}

/** What the earlier routes (GET /summary, GET /p/:token, GET /translate) return: the fixed JSON plus the expiry facts. */
export interface PatientView {
  language: string;
  steps: AiOutput["steps"];
  medications: AiOutput["medications"];
  followUps: AiOutput["followUps"];
  warnings: AiOutput["warnings"];
  expiresAt: string;
  daysLeft: number;
  availableLanguages: string[];
  fromCache: boolean;
}

export function patientView(r: LanguageResult, access: SummaryAccess): PatientView {
  return {
    language: r.output.language,
    steps: r.output.steps,
    medications: r.output.medications,
    followUps: r.output.followUps,
    warnings: r.output.warnings,
    expiresAt: access.expiresAt,
    daysLeft: access.daysLeft,
    availableLanguages: r.availableLanguages.length ? r.availableLanguages : [ENGLISH],
    fromCache: r.fromCache,
  };
}
