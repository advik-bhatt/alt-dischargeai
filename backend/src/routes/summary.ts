import { Router } from "express";
import type { AppContext } from "../context.js";
import { resolveLink } from "./linkAccess.js";

/** GET /summary?link=<linkId> (patient): the plain-language summary with expiry stated upfront. */
export function summaryRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/summary", async (req, res) => {
    const access = await resolveLink(ctx, req.query.link);
    const checklistState = await ctx.checklist.listForLink(access.linkIdHash);
    await ctx.links.touchViewed(access.linkIdHash, ctx.clock.nowIso());
    await ctx.audit.append({ event: "summary.viewed", linkIdHash: access.linkIdHash, actor: "patient", at: ctx.clock.nowIso(), details: { daysLeft: access.daysLeft } });
    res.json({
      ...access.stored.summary,
      status: access.link.status,
      expiresAt: access.expiresAt,
      daysLeft: access.daysLeft,
      createdAt: access.link.createdAt,
      warnings: access.stored.warnings,
      needsReview: access.link.status === "needs_review",
      checklistState,
      verification: {
        provider: access.stored.provider,
        model: access.stored.model,
        fidelityCheck: access.stored.warnings.some((w) => w.code === "med_not_in_source" || w.code === "dose_not_in_source") ? "failed" : "passed",
        readabilityGrade: access.stored.readabilityGrade,
        sourceChars: access.stored.sourceChars,
        inputKind: access.stored.inputKind,
      },
    });
  });
  return r;
}
