import { Router } from "express";
import type { AppContext } from "../context.js";
import { hashPrefix } from "../crypto/linkId.js";

/** GET /jobs/:jobId (provider): follow the 202. Stage, the safety-check result and run metadata; no patient text. */
export function jobsRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/jobs/:jobId", async (req, res) => {
    const job = await ctx.jobs.get(req.params.jobId);
    if (!job) {
      res.status(404).json({ error: "job_not_found" });
      return;
    }
    const link = await ctx.links.getByHash(job.linkIdHash);
    res.json({
      jobId: job.id,
      stage: job.stage,
      inputKind: job.inputKind,
      error: job.error,
      safety: job.safety,
      verified: job.safety ? job.safety.passed : null,
      languages: link?.languages ?? [],
      meta: job.meta,
      linkIdHash: job.linkIdHash,
      linkRef: hashPrefix(job.linkIdHash),
      linkStatus: link?.status ?? null,
      expiresAt: link?.expiresAt ?? null,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    });
  });
  return r;
}
