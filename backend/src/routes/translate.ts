import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { languageFor, patientView, resolveSummary, sumIdFromQuery } from "./linkAccess.js";

/**
 * GET /translate?link=<sumId>&language=<name or code> (patient): the earlier route, kept as an
 * alias of GET /translation?lang=&sum_id=. Same cache-first rule, the flattened view shape.
 */
export function translateRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/translate", async (req, res) => {
    const q = req.query as Record<string, unknown>;
    const language = [q.language, q.lang].find((v) => typeof v === "string" && v.trim()) as string | undefined;
    if (!language) throw badRequest("missing_language", "language is required, e.g. language=Spanish or language=es");
    const sumId = sumIdFromQuery(q);
    if (!sumId) throw badRequest("invalid_link", "link is required, e.g. /translate?link=<sumId>&language=es");
    const access = await resolveSummary(ctx, sumId);
    res.json(patientView(await languageFor(ctx, access, language), access));
  });
  return r;
}
