import { Router } from "express";
import type { AppContext } from "../context.js";

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "dischargeai-backend",
      node: process.version,
      clock: { now: ctx.clock.nowIso(), offsetDays: ctx.clock.offsetDays, demoNow: ctx.clock.demoNow },
      linkTtlDays: ctx.linkTtlDays,
      config: {
        source: ctx.secrets.source,
        secretArn: ctx.secrets.arn ?? null,
        fromSecret: ctx.secrets.applied,
        overriddenByEnv: ctx.secrets.overriddenByEnv,
        missingKeys: ctx.secrets.missingKeys,
        reason: ctx.secrets.reason ?? null,
      },
      providers: {
        llm: ctx.simplifier.name,
        llmModel: ctx.config.LLM_PROVIDER === "bedrock" ? ctx.config.BEDROCK_MODEL_ID : ctx.config.ANTHROPIC_MODEL,
        speech: ctx.speechToText.name,
        sqlConnection: ctx.db.describe,
        docStore: ctx.summaries.name,
        docStoreTarget: ctx.summaries.describe,
        pdf: ctx.pdf.describe(),
        audio: ctx.audio.describe(),
        receipts: ctx.receipts.name,
        email: ctx.mailer.transportName,
        emailQueue: ctx.emailQueue ? "sqs" : "none",
      },
      queue: { pending: ctx.queue.size },
    });
  });
  return r;
}
