import { Router } from "express";
import type { AppContext } from "../context.js";
import { resolveLink, serveLanguage } from "./linkAccess.js";

/**
 * GET /p/:token[?language=] (patient): the diagram's token link. The token is the same 128-bit
 * link id the email carries, in the path instead of the query string; the handler is the one
 * GET /summary uses, so `language` follows the note's cache-first rule.
 */
export function patientLinkRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/p/:token", async (req, res) => {
    const access = await resolveLink(ctx, req.params.token);
    res.json(await serveLanguage(ctx, access, req.query.language));
  });
  return r;
}
