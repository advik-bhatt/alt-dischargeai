import { Router } from "express";
import type { AppContext } from "../context.js";
import { hashLinkId, isLinkIdShaped } from "../crypto/linkId.js";
import { badRequest } from "../errors.js";

/** GET /audit?link=<linkId> (provider): the event trail for a link. Never contains PHI. */
export function auditRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/audit", async (req, res) => {
    const link = req.query.link;
    if (!isLinkIdShaped(link)) throw badRequest("invalid_link", "link must be a 22-character link id");
    const linkIdHash = hashLinkId(link);
    const events = await ctx.audit.listForLink(linkIdHash);
    const record = await ctx.links.getByHash(linkIdHash);
    res.json({
      linkIdHash,
      link: record
        ? { status: record.status, createdAt: record.createdAt, expiresAt: record.expiresAt, keyDestroyed: record.encKey === null, lastViewedAt: record.lastViewedAt }
        : null,
      events,
    });
  });
  return r;
}
