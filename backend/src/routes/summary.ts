import { Router } from "express";
import type { AppContext } from "../context.js";
import { resolveLink, serveLanguage } from "./linkAccess.js";

/**
 * GET /summary?link=<linkId>[&language=] (patient): the LLM response for the link, read from the
 * document store, with the expiry stated upfront. `language` is optional and follows the same
 * cache-first rule as GET /translate.
 */
export function summaryRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/summary", async (req, res) => {
    const access = await resolveLink(ctx, req.query.link);
    res.json(await serveLanguage(ctx, access, req.query.language));
  });
  return r;
}
