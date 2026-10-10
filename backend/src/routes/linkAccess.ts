import type { AppContext } from "../context.js";
import { hashLinkId, isLinkIdShaped } from "../crypto/linkId.js";
import type { LinkRecord } from "../db/repos/links.js";
import type { StoredSummary, StoredTranslation } from "../docstore/documents.js";
import { SK } from "../docstore/types.js";
import { AppError, badRequest, gone, notFound, tooEarly } from "../errors.js";
import { ENGLISH, languageName, normalizeLanguage } from "../pipeline/languages.js";
import { checkTranslation } from "../pipeline/safetyChecks.js";

export interface LinkAccess {
  linkIdHash: string;
  link: LinkRecord;
  stored: StoredSummary;
  expiresAt: string;
  daysLeft: number;
}

/**
 * Every patient endpoint goes through here. Order matters:
 *   400 malformed id -> 404 unknown -> 410 purged / expired (checked against the app clock at read
 *   time, independently of the purge job) -> 425 still processing -> 423 needs clinician review ->
 *   500 failed -> decrypt and return.
 * A link found expired here is marked expired and audited at once; the purge job shreds its key next.
 */
export async function resolveLink(ctx: AppContext, linkParam: unknown): Promise<LinkAccess> {
  if (!isLinkIdShaped(linkParam)) throw badRequest("invalid_link", "link must be the 22-character id from your email");
  const linkIdHash = hashLinkId(linkParam);
  const link = await ctx.links.getByHash(linkIdHash);
  if (!link) throw notFound("link_not_found", "No discharge summary exists for this link");

  const now = ctx.clock.now();
  const expiresAt = new Date(link.expiresAt);
  if (link.status === "purged") {
    throw gone("link_purged", "This discharge summary was permanently deleted 30 days after it was created", { expiresAt: link.expiresAt });
  }
  if (link.status === "expired" || expiresAt.getTime() <= now.getTime() || !link.encKey) {
    if (link.status !== "expired") {
      await ctx.links.setStatus(linkIdHash, "expired");
      await ctx.audit.append({ event: "link.expired", linkIdHash, actor: "system", at: ctx.clock.nowIso(), details: { detectedAt: "read" } });
    }
    throw gone("link_expired", "This discharge summary expired 30 days after it was created", { expiresAt: link.expiresAt });
  }

  const job = await ctx.jobs.latestForLink(linkIdHash);
  if (link.status === "pending" || (job && !["done", "needs_review", "failed"].includes(job.stage) && link.status !== "ready")) {
    throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "received", jobId: job?.id, expiresAt: link.expiresAt });
  }
  if (link.status === "needs_review") {
    throw new AppError(423, "needs_review", "Your care team is reviewing this summary before it can be shown", { expiresAt: link.expiresAt });
  }
  if (link.status === "failed") {
    throw new AppError(500, "processing_failed", "The summary could not be prepared", { expiresAt: link.expiresAt });
  }

  const stored = await ctx.secureDocs.getJson<StoredSummary>({ linkIdHash, sk: SK.simplified, key: link.encKey });
  if (!stored) throw tooEarly("processing", "Your summary is still being prepared", { stage: job?.stage ?? "stored", expiresAt: link.expiresAt });

  const daysLeft = Math.max(0, Math.ceil((expiresAt.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)));
  return { linkIdHash, link, stored, expiresAt: link.expiresAt, daysLeft };
}

/** What GET /summary, GET /p/:token and GET /translate all return: the fixed JSON plus the expiry facts. */
export interface PatientView {
  language: string;
  steps: StoredSummary["output"]["steps"];
  medications: StoredSummary["output"]["medications"];
  followUps: StoredSummary["output"]["followUps"];
  warnings: StoredSummary["output"]["warnings"];
  expiresAt: string;
  daysLeft: number;
  availableLanguages: string[];
  fromCache: boolean;
}

/**
 * The note's cache-first rule in one place: English is the stored LLM response; any other language
 * is served from the document store when present, otherwise the translation agent runs once, the
 * result is checked (names, doses and numbers verbatim), stored with the link's expiry, and served.
 */
export async function serveLanguage(ctx: AppContext, access: LinkAccess, languageParam: unknown): Promise<PatientView> {
  const requested = typeof languageParam === "string" && languageParam.trim() ? normalizeLanguage(languageParam) : ENGLISH;
  if (!requested) throw badRequest("invalid_language", `language must be a BCP-47 code or a language name (got "${String(languageParam)}")`);
  const { link, linkIdHash, stored } = access;
  const now = ctx.clock.nowIso();
  await ctx.links.touchViewed(linkIdHash, now);

  if (requested === ENGLISH) {
    await ctx.audit.append({ event: "summary.viewed", linkIdHash, actor: "patient", at: now, details: { language: ENGLISH, daysLeft: access.daysLeft } });
    return view(stored.output, access, link.languages, true);
  }

  const key = link.encKey!;
  const base = requested.split("-")[0];
  for (const lang of [...new Set([requested, base])]) {
    const cached = await ctx.secureDocs.getJson<StoredTranslation>({ linkIdHash, sk: SK.translation(lang), key });
    if (cached) {
      await ctx.audit.append({ event: "translation.viewed", linkIdHash, actor: "patient", at: now, details: { language: lang, fromCache: true } });
      return view(cached.output, access, link.languages, true);
    }
  }

  let result: Awaited<ReturnType<AppContext["translator"]["translate"]>>;
  try {
    result = await ctx.translator.translate({ english: stored.output, language: requested, languageName: languageName(requested) });
  } catch (err) {
    ctx.log.warn({ link: linkIdHash.slice(0, 8), language: requested, err: { message: (err as Error).message } }, "translation agent failed");
    throw new AppError(502, "translation_failed", "The translation could not be produced right now; the English summary is still available", { language: requested });
  }
  const output = { ...result.output, language: requested };
  const check = checkTranslation(stored.output, output);
  if (!check.passed) {
    await ctx.audit.append({ event: "translation.created", linkIdHash, actor: "patient", at: now, details: { language: requested, provider: result.provider, model: result.model, rejected: true, issues: check.issues } });
    throw new AppError(422, "translation_rejected", "The translation changed a medication name, dose or number and was not accepted", { language: requested, issues: check.issues });
  }
  const translation: StoredTranslation = { output, check, provider: result.provider, model: result.model, usage: result.usage, fixture: result.fixture, latencyMs: result.latencyMs, createdAt: now };
  await ctx.secureDocs.putJson({
    linkIdHash,
    sk: SK.translation(requested),
    key,
    keyVersion: link.keyVersion,
    value: translation,
    expiresAtEpochSeconds: Math.floor(new Date(access.expiresAt).getTime() / 1000),
    createdAt: now,
  });
  const available = await ctx.links.addLanguage(linkIdHash, requested);
  await ctx.audit.append({ event: "translation.created", linkIdHash, actor: "patient", at: now, details: { language: requested, provider: result.provider, model: result.model, latencyMs: result.latencyMs } });
  return view(output, access, available, false);
}

function view(output: StoredSummary["output"], access: LinkAccess, available: string[], fromCache: boolean): PatientView {
  return {
    language: output.language,
    steps: output.steps,
    medications: output.medications,
    followUps: output.followUps,
    warnings: output.warnings,
    expiresAt: access.expiresAt,
    daysLeft: access.daysLeft,
    availableLanguages: available.length ? available : [ENGLISH],
    fromCache,
  };
}
