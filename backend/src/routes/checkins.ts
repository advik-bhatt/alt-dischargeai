import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import type { CheckIn, CheckInFlag, SummaryItem } from "../docstore/types.js";
import { resolveSummary, sumIdFromQuery } from "./linkAccess.js";

/**
 * The 30 days after discharge. The patient (or caregiver) checks in from the plan page: whether
 * today's medicines were taken, which of the plan's own warning signs they have, their weight, and
 * one teach-back question about when a medicine is taken. Flags are plain rules in code, never a
 * model, and the care team reads them on the dashboard (GET /followups).
 *
 * Check-ins live on the summary item itself, so the 30-day purge deletes them with the plan.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** Weight-gain rules from common heart-failure guidance: about 2 lb in a day or 5 lb in a week. */
export const WEIGHT_GAIN_DAY_LB = 2;
export const WEIGHT_GAIN_WEEK_LB = 5;
/** No check-in for this many days after the first one is itself a flag. */
export const MISSED_DAYS_FLAG = 2;
const MAX_CHECKINS = 120;

const Sign = z.string().trim().min(1).max(300);
const Body = z.object({
  token: z.string(),
  by: z.enum(["patient", "caregiver"]).default("patient"),
  language: z.string().max(16).default("en"),
  meds: z.enum(["all", "some", "none", "no_meds"]),
  urgentSigns: z.array(Sign).max(30).default([]),
  callDoctorSigns: z.array(Sign).max(30).default([]),
  weightLb: z.number().min(40).max(800).optional(),
  teachBack: z.object({ medicine: z.string().trim().min(1).max(200), correct: z.boolean() }).optional(),
});

/** Day 1 is the day the plan was created. */
export function dayOfPlan(createdAt: string, now: Date): number {
  return Math.max(1, Math.floor((now.getTime() - Date.parse(createdAt)) / DAY_MS) + 1);
}

/** The rules. `previous` is every earlier check-in, oldest first. */
export function flagCheckIn(input: Omit<CheckIn, "flags">, previous: CheckIn[]): CheckInFlag[] {
  const flags: CheckInFlag[] = [];
  if (input.urgentSigns.length) flags.push({ level: "urgent", code: "warning_sign", text: `Reports a get-help-now warning sign: ${input.urgentSigns.join("; ")}` });
  if (input.callDoctorSigns.length) flags.push({ level: "attention", code: "call_doctor_sign", text: `Reports a call-your-doctor sign: ${input.callDoctorSigns.join("; ")}` });
  if (input.meds === "some") flags.push({ level: "attention", code: "missed_some_meds", text: "Missed some of today's medicines" });
  if (input.meds === "none") flags.push({ level: "attention", code: "missed_all_meds", text: "Took none of today's medicines" });
  if (input.weightLb !== undefined) {
    const at = Date.parse(input.at);
    const weighed = previous.filter((c) => c.weightLb !== undefined);
    const lastDay = weighed.filter((c) => at - Date.parse(c.at) <= 1.5 * DAY_MS).at(-1);
    const week = weighed.filter((c) => at - Date.parse(c.at) <= 7 * DAY_MS).map((c) => c.weightLb!);
    const dayGain = lastDay ? input.weightLb - lastDay.weightLb! : 0;
    const weekGain = week.length ? input.weightLb - Math.min(...week) : 0;
    if (dayGain >= WEIGHT_GAIN_DAY_LB) flags.push({ level: "attention", code: "weight_gain_day", text: `Weight up ${round(dayGain)} lb since the last check-in` });
    else if (weekGain >= WEIGHT_GAIN_WEEK_LB) flags.push({ level: "attention", code: "weight_gain_week", text: `Weight up ${round(weekGain)} lb this week` });
  }
  if (input.teachBack && !input.teachBack.correct) flags.push({ level: "attention", code: "teach_back_missed", text: `Unsure when to take ${input.teachBack.medicine}` });
  return flags;
}

const round = (n: number) => Math.round(n * 10) / 10;

/** The follow-up picture of one plan, for the patient's page and the care team's dashboard. */
export function followUpSummary(item: Pick<SummaryItem, "createdAt" | "checkins">, now: Date) {
  const checkins = item.checkins ?? [];
  const day = Math.min(30, dayOfPlan(item.createdAt, now));
  const days = new Set(checkins.map((c) => c.day));
  const last = checkins.at(-1);
  const flags: CheckInFlag[] = [...(last?.flags ?? [])];
  const sinceLast = last ? day - last.day : day - 1;
  if (sinceLast >= MISSED_DAYS_FLAG) flags.push({ level: "attention", code: "no_checkin", text: `No check-in for ${sinceLast} days` });
  const weights = checkins.filter((c) => c.weightLb !== undefined).map((c) => c.weightLb!);
  return {
    day,
    daysCheckedIn: days.size,
    checkedInToday: days.has(day),
    lastCheckinAt: last?.at ?? null,
    lastWeightLb: weights.at(-1) ?? null,
    weightChangeLb: weights.length > 1 ? round(weights.at(-1)! - weights[0]) : null,
    flags,
    level: flags.some((f) => f.level === "urgent") ? "urgent" : flags.length ? "attention" : "ok",
    /** One entry per day with a check-in: the worst level that day. */
    timeline: [...days].sort((a, b) => a - b).map((d) => {
      const that = checkins.filter((c) => c.day === d).flatMap((c) => c.flags);
      return { day: d, level: that.some((f) => f.level === "urgent") ? "urgent" : that.length ? "attention" : "ok" };
    }),
  };
}

export function checkinsRouter(ctx: AppContext): Router {
  const r = Router();

  r.post("/checkin", async (req, res) => {
    const body = Body.parse(req.body);
    const access = await resolveSummary(ctx, body.token);
    const now = ctx.clock.now();
    const previous = access.item.checkins ?? [];
    const entry: Omit<CheckIn, "flags"> = {
      at: now.toISOString(), day: dayOfPlan(access.item.createdAt, now), by: body.by, language: body.language, meds: body.meds,
      urgentSigns: body.urgentSigns, callDoctorSigns: body.callDoctorSigns,
      ...(body.weightLb !== undefined ? { weightLb: body.weightLb } : {}), ...(body.teachBack ? { teachBack: body.teachBack } : {}),
    };
    const checkin: CheckIn = { ...entry, flags: flagCheckIn(entry, previous) };
    const checkins = [...previous, checkin].slice(-MAX_CHECKINS);
    await ctx.summaries.update(access.sumId, { checkins });
    // The audit log records that a check-in happened and which rules fired, never the answers.
    await ctx.audit.append({ event: "checkin.recorded", sumId: access.sumId, actor: "patient", at: checkin.at, details: { day: checkin.day, flags: checkin.flags.map((f) => f.code) } });
    res.status(201).json({ checkin, followUp: followUpSummary({ createdAt: access.item.createdAt, checkins }, now) });
  });

  r.get("/checkins", async (req, res) => {
    const access = await resolveSummary(ctx, sumIdFromQuery(req.query as Record<string, unknown>));
    res.json({ followUp: followUpSummary(access.item, ctx.clock.now()), checkins: access.item.checkins ?? [] });
  });

  /** Provider: every live plan's follow-up, the flagged ones first. */
  r.get("/followups", async (_req, res) => {
    const now = ctx.clock.now();
    const links = await ctx.activeLinks.listLive(now.toISOString());
    const rows = [];
    for (const link of links) {
      const item = await ctx.summaries.get(link.sumId);
      if (!item) continue;
      rows.push({ patientID: link.patientID, sumId: link.sumId, link: ctx.patientUrl(link.sumId), createdAt: link.createdAt, expiresAt: link.expiresAt,
        ...followUpSummary(item, now) });
    }
    const rank = { urgent: 0, attention: 1, ok: 2 } as const;
    rows.sort((a, b) => rank[a.level as keyof typeof rank] - rank[b.level as keyof typeof rank] || a.patientID.localeCompare(b.patientID));
    res.json({ now: now.toISOString(), followups: rows });
  });

  return r;
}
