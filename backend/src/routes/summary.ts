import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { languageFor, patientView, resolveSummary, sumIdFromQuery } from "./linkAccess.js";

/**
 * GET /summary?link=<sumId>[&language=] (patient): the earlier route, kept as an alias of
 * GET /llm-sumary. Returns the fixed JSON flattened with the expiry facts; `language` follows the
 * same cache-first rule as GET /translation. `sum-id` and `sum_id` are accepted in place of `link`.
 */
export function summaryRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/summary", async (req, res) => {
    const sumId = sumIdFromQuery(req.query as Record<string, unknown>);
    if (!sumId) throw badRequest("invalid_link", "link is required, e.g. /summary?link=<sumId>");
    const access = await resolveSummary(ctx, sumId);
    res.json(patientView(await languageFor(ctx, access, req.query.language), access));
  });
  return r;
}
