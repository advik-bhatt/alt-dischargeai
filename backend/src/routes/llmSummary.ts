import { Router } from "express";
import type { AppContext } from "../context.js";
import { languagesOf } from "../docstore/types.js";
import { badRequest } from "../errors.js";
import { resolveSummary, sumIdFromQuery } from "./linkAccess.js";

/**
 * The team contract: `GET /llm-sumary?sum-id=...` (spelled exactly so) "gets llm generated summary
 * based on the summary id from the dynamodb table". `GET /llm-summary` and `?sum_id=` are served too.
 * Answers 404 unknown, 410 expired or deleted, 425 still processing, 423 held for review.
 */
export function llmSummaryRouter(ctx: AppContext): Router {
  const r = Router();
  const handler = async (req: Parameters<Parameters<Router["get"]>[1]>[0], res: Parameters<Parameters<Router["get"]>[1]>[1]) => {
    const sumId = sumIdFromQuery(req.query as Record<string, unknown>);
    if (!sumId) throw badRequest("missing_sum_id", "sum-id is required, e.g. /llm-sumary?sum-id=<id from POST /ingest>");
    const access = await resolveSummary(ctx, sumId);
    await ctx.activeLinks.touchViewed(access.sumId, ctx.clock.nowIso());
    await ctx.audit.append({ event: "summary.viewed", sumId: access.sumId, actor: "patient", at: ctx.clock.nowIso(), details: { language: "en", daysLeft: access.daysLeft, route: "llm-sumary" } });
    res.json({
      "sum-id": access.sumId,
      sumId: access.sumId,
      patientID: access.item.patientID,
      language: access.english.language,
      status: access.item.status,
      "llm-summary": access.english,
      availableLanguages: languagesOf(access.item),
      createdAt: access.item.createdAt,
      expiresAt: access.expiresAt,
      daysLeft: access.daysLeft,
    });
  };
  r.get("/llm-sumary", handler);
  r.get("/llm-summary", handler);
  return r;
}
