import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";

const Advance = z.object({ days: z.number().min(-365).max(3650) });

/**
 * Demo controls, mounted only when DEMO_MODE=true and behind the provider key:
 *   POST /admin/clock/advance { days }  shifts the app clock so day 30 arrives on stage.
 *   POST /admin/clock/reset             puts it back.
 *   POST /admin/purge                   runs the purge job now and returns what it did.
 */
export function adminRouter(ctx: AppContext): Router {
  const r = Router();

  r.post("/admin/clock/advance", async (req, res) => {
    const { days } = Advance.parse(req.body ?? {});
    ctx.clock.advanceDays(days);
    await ctx.audit.append({ event: "clock.advanced", actor: "provider", at: ctx.clock.nowIso(), details: { days, offsetDays: ctx.clock.offsetDays } });
    res.json({ now: ctx.clock.nowIso(), offsetDays: ctx.clock.offsetDays });
  });

  r.post("/admin/clock/reset", async (_req, res) => {
    ctx.clock.reset();
    res.json({ now: ctx.clock.nowIso(), offsetDays: 0 });
  });

  r.post("/admin/purge", async (_req, res) => {
    const report = await ctx.purge();
    res.json(report);
  });

  return r;
}
