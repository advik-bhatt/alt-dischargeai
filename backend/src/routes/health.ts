import { timingSafeEqual } from "node:crypto";
import { Router, type Request } from "express";
import type { AppContext } from "../context.js";

/**
 * The hosted deployment is public, so there /health answers anonymous callers with what the UI
 * needs (mode, capabilities, the link lifetime) and keeps the diagnostics (account, runtime ARN,
 * database user and host, config sources) for callers that send the provider key. Local and AWS
 * modes keep answering everything, as their tests and scripts expect.
 */
function showDiagnostics(ctx: AppContext, req: Request): boolean {
  if (ctx.mode !== "hosted") return true;
  const header = req.header("x-provider-key");
  const given = Buffer.from(typeof header === "string" ? header : "", "utf8");
  const expected = Buffer.from(ctx.config.PROVIDER_API_KEY, "utf8");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function healthRouter(ctx: AppContext): Router {
  const r = Router();
  r.get("/health", (req, res) => {
    const capabilities = { liveAi: ctx.agent.name === "agentcore", dictation: !!ctx.liveDictation, translation: !!ctx.translator, readAloud: !!ctx.readAloud, chat: !!ctx.chat };
    if (!showDiagnostics(ctx, req)) {
      res.json({ ok: true, service: "dischargeai-backend", mode: ctx.mode, capabilities, linkTtlDays: ctx.linkTtlDays });
      return;
    }
    res.json({
      ok: true,
      service: "dischargeai-backend",
      mode: ctx.mode ?? "aws",
      capabilities,
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
        llm: ctx.agent.name,
        agentRuntimeArn: ctx.agent.runtimeArn,
        agentQualifier: ctx.config.AGENT_QUALIFIER ?? "DEFAULT",
        speech: ctx.speechToText.name,
        liveDictation: ctx.liveDictation?.name ?? "unavailable",
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
