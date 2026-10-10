import { Router } from "express";
import type { AppContext } from "../context.js";
import type { ObjectStore, ObjectStoreStatus } from "../data/objects.js";

function objectStoreHealth(store: ObjectStore, status: ObjectStoreStatus) {
  return { store: status.active, requested: status.requested, bucket: status.bucket, target: store.describe(), fallbackReason: status.fallbackReason ?? null };
}

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
        llmModel: ctx.config.LLM_PROVIDER === "bedrock" ? ctx.config.BEDROCK_MODEL_ID : ctx.config.LLM_PROVIDER === "anthropic" ? ctx.config.ANTHROPIC_MODEL : "fixtures+rules",
        speech: ctx.speechToText.name,
        sql: ctx.db.dialect,
        sqlConnection: ctx.db.describe,
        docStore: ctx.summaries.name,
        docStoreTarget: ctx.summaries.describe,
        pdf: objectStoreHealth(ctx.pdf, ctx.pdfStatus),
        audio: objectStoreHealth(ctx.audio, ctx.audioStatus),
        receipts: ctx.receipts.name,
        email: ctx.mailer.transportName,
        emailQueue: ctx.emailQueue ? "sqs" : "none",
      },
      queue: { pending: ctx.queue.size },
    });
  });
  return r;
}
