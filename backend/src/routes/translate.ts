import { Router } from "express";
import type { AppContext } from "../context.js";
import { badRequest } from "../errors.js";
import { resolveLink, serveLanguage } from "./linkAccess.js";

/**
 * GET /translate?link=<linkId>&language=<name or BCP-47 code> (patient): the note's on-demand
 * translation. The document store is checked first; on a miss the translation agent runs once,
 * the result is checked and cached under the link's expiry. `fromCache` says which path answered.
 */
export function translateRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/translate", async (req, res) => {
    const language = typeof req.query.language === "string" ? req.query.language.trim() : "";
    if (!language) throw badRequest("missing_language", "language is required, e.g. language=Spanish or language=es");
    const access = await resolveLink(ctx, req.query.link);
    res.json(await serveLanguage(ctx, access, language));
  });
  return r;
}
