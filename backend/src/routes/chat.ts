import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { AppError } from "../errors.js";
import { resolveSummary } from "./linkAccess.js";

const Body = z.object({
  token: z.string(),
  question: z.string().trim().min(1).max(1000),
  history: z.array(z.tuple([z.string().max(1000), z.string().max(4000)])).max(6).default([]),
});

/** The Going-Home Plan Markdown the agent wrote: `summary` on the live runtime, `result` on the hackathon one. */
export function planMarkdown(llmSummary: unknown): string | undefined {
  if (typeof llmSummary === "string") return llmSummary.trim() || undefined;
  if (!llmSummary || typeof llmSummary !== "object") return undefined;
  const value = llmSummary as Record<string, unknown>;
  const text = typeof value.summary === "string" ? value.summary : typeof value.result === "string" ? value.result : "";
  return text.trim() || undefined;
}

/** Patient Q&A about their own plan. Authenticated like every patient read: the link id, checked for expiry. */
export function chatRouter(ctx: AppContext) {
  const r = Router();
  r.post("/chat", async (req, res) => {
    if (!ctx.chat) throw new AppError(501, "chat_unavailable", "The plan assistant is not configured on this server");
    const { token, question, history } = Body.parse(req.body);
    const access = await resolveSummary(ctx, token);
    const plan = planMarkdown(access.llmSummary);
    if (!plan) throw new AppError(409, "plan_unavailable", "This plan has no text the assistant can read");
    const reply = await ctx.chat.ask(plan, question, history);
    // Re-check the 30-day boundary after the model call; record that a question was asked, never its text.
    await resolveSummary(ctx, token);
    await ctx.audit.append({ event: "chat.answered", sumId: access.sumId, actor: "patient", at: ctx.clock.nowIso(), details: { route: reply.route } });
    res.json(reply);
  });
  return r;
}
