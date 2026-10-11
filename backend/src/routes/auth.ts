import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { isSumIdShaped } from "../crypto/sumId.js";
import { AppError, unauthorized } from "../errors.js";
import { resolveSummary } from "./linkAccess.js";

const Login = z.object({ email: z.string(), password: z.string() });
const Access = z.object({ token: z.string().trim(), dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), role: z.enum(["patient", "caregiver"]) });
const denied = () => unauthorized("invalid_credentials", "The information entered doesn't match our records.");

export function authRouter(ctx: AppContext): Router {
  const r = Router();
  const isLocal = () => ctx.mode === "local-test" || ctx.mode === "local-agentcore";
  // The demo patient codes resolve to Alex Example's latest plan in the local runner and the hosted demo.
  const demoCodes = () => isLocal() || ctx.mode === "hosted";
  // The local runner has a fixed demo login. The hosted mode signs in the one provider account set by
  // DOCTOR_EMAIL / DOCTOR_PASSWORD. Anything else needs an identity provider.
  const providerAccount = (): { email: string; password: string; displayName: string } | undefined => {
    if (isLocal()) return { email: "rivera@demo.health", password: "demo1234", displayName: "Dr. A. Rivera" };
    if (ctx.mode === "hosted" && ctx.config.DOCTOR_EMAIL && ctx.config.DOCTOR_PASSWORD) {
      return { email: ctx.config.DOCTOR_EMAIL.toLowerCase(), password: ctx.config.DOCTOR_PASSWORD, displayName: ctx.config.DOCTOR_DISPLAY_NAME };
    }
    return undefined;
  };
  r.post("/auth/login", (req, res) => {
    const body = Login.parse(req.body);
    const account = providerAccount();
    if (!account) throw new AppError(501, "provider_login_not_configured", "Provider email sign-in is not configured. Use the provider API key in Swagger.");
    const given = Buffer.from(body.password);
    const expected = Buffer.from(account.password);
    const passwordOk = given.length === expected.length && timingSafeEqual(given, expected);
    if (body.email.trim().toLowerCase() !== account.email || !passwordOk) throw denied();
    res.json({ role: "doctor", displayName: account.displayName, subtitle: "Internal Medicine", providerKey: ctx.config.PROVIDER_API_KEY });
  });
  // DOB is checked against the real patient repository. Existing summary APIs remain bearer-link APIs.
  r.post("/auth/link", async (req, res) => {
    const body = Access.parse(req.body);
    let token = body.token;
    if (demoCodes() && ["demo-token-123", "demo-caregiver-456"].includes(token)) {
      const latest = await ctx.activeLinks.activeForPatient("7", ctx.clock.nowIso());
      if (!latest) throw new AppError(409, "no_local_plan", "Send a writeup for Alex Example first, then use its patient link.");
      token = latest.sumId;
    }
    if (!isSumIdShaped(token)) throw denied();
    const item = await ctx.summaries.get(token);
    const patient = item ? await ctx.patients.getById(item.patientID) : undefined;
    if (!patient || patient.dateOfBirth?.slice(0, 10) !== body.dob) throw denied();
    await resolveSummary(ctx, token);
    res.json({ role: body.role, displayName: body.role === "caregiver" ? (patient.caregiverName ?? "Caregiver") : "Your recovery plan",
      subtitle: body.role === "caregiver" ? "Caregiver · linked to 1 patient" : "Patient", patientId: patient.id, patientToken: token,
      ...(body.role === "caregiver" ? { caregiverPatientIds: [patient.id] } : {}) });
  });
  return r;
}
