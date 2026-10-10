import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { notFound } from "../errors.js";
import { resolveLink } from "./linkAccess.js";

const Body = z.object({
  link: z.string(),
  itemId: z.string().min(1),
  completed: z.boolean(),
});

/** POST /checklist/complete (patient): persists a check-off; GET /checklist?link= returns the state. */
export function checklistRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/checklist", async (req, res) => {
    const access = await resolveLink(ctx, req.query.link);
    const state = await ctx.checklist.listForLink(access.linkIdHash);
    res.json({ items: access.stored.summary.checklist, state });
  });

  r.post("/checklist/complete", async (req, res) => {
    const body = Body.parse(req.body ?? {});
    const access = await resolveLink(ctx, body.link);
    const item = access.stored.summary.checklist.find((c) => c.id === body.itemId);
    if (!item) throw notFound("checklist_item_not_found", `No checklist item ${body.itemId}`);
    await ctx.checklist.upsert(access.linkIdHash, body.itemId, body.completed, ctx.clock.nowIso());
    await ctx.audit.append({ event: "checklist.updated", linkIdHash: access.linkIdHash, actor: "patient", at: ctx.clock.nowIso(), details: { itemId: body.itemId, completed: body.completed } });
    const state = await ctx.checklist.listForLink(access.linkIdHash);
    res.json({ itemId: body.itemId, completed: body.completed, state });
  });

  return r;
}
