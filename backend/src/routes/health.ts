import { Router } from "express";
import type { AppContext } from "../context.js";

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/health", (_req, res) => {
    res.json({
      ok: true,
      service: "dischargeai-backend",
      clock: { now: ctx.clock.nowIso(), offsetDays: ctx.clock.offsetDays, demoNow: ctx.clock.demoNow },
      linkTtlDays: ctx.linkTtlDays,
      providers: {
        llm: ctx.simplifier.name,
        llmModel: ctx.config.LLM_PROVIDER === "bedrock" ? ctx.config.BEDROCK_MODEL_ID : ctx.config.LLM_PROVIDER === "anthropic" ? ctx.config.ANTHROPIC_MODEL : "fixtures+rules",
        speech: ctx.speechToText.name,
        sql: ctx.db.dialect,
        docStore: ctx.docStore.name,
        email: ctx.mailer.transportName,
        emailQueue: ctx.emailQueue ? "sqs" : "none",
      },
      queue: { pending: ctx.queue.size },
    });
  });
  return r;
}
