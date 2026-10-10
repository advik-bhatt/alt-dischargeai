import { Router } from "express";
import type { AppContext } from "../context.js";
import { hashPrefix } from "../crypto/linkId.js";

/** GET /jobs/:jobId (provider): pipeline status without PHI. */
export function jobsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/jobs/:jobId", async (req, res) => {
    const job = await ctx.jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    res.json({
      jobId: job.id,
      stage: job.stage,
      inputKind: job.inputKind,
      error: job.error,
      warnings: job.warnings,
      meta: job.meta,
      linkIdHash: job.linkIdHash,
      linkRef: hashPrefix(job.linkIdHash),
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });
  return r;
}
