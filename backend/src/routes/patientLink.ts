import { Router } from "express";
import type { AppContext } from "../context.js";
import { languageFor, patientView, resolveSummary } from "./linkAccess.js";

/**
 * GET /p/:token[?language=] (patient): the diagram's token link, kept as an alias. The token is the
 * sumId the email carries, in the path instead of the query string; `language` follows the
 * cache-first rule of GET /translation.
 */
export function patientLinkRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/p/:token", async (req, res) => {
    const access = await resolveSummary(ctx, req.params.token);
    res.json(patientView(await languageFor(ctx, access, req.query.language), access));
  });
  return r;
}
