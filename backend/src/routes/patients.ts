import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";

const NewPatientBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  zipCode: z.string().trim().min(3).max(12),
  email: z.string().trim().email(),
  phone: z.string().trim().min(5).max(30),
  preferredLanguage: z.string().trim().min(2).max(10).optional(),
});

/** Provider endpoints: list/search and create patients. */
export function patientsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/patients", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const patients = await ctx.patients.list(q);
    res.json({ patients, count: patients.length });
  });

  r.get("/patients/:id", async (req, res) => {
    const p = await ctx.patients.getById(req.params.id);
    if (!p) {
      res.status(404).json({ error: "patient_not_found" });
      return;
    }
    res.json(p);
  });

  r.post("/patients", async (req, res) => {
    const body = NewPatientBody.parse(req.body ?? {});
    const patient = await ctx.patients.create(body, ctx.clock.nowIso());
    await ctx.audit.append({ event: "patient.created", actor: "provider", at: ctx.clock.nowIso(), details: { patientId: patient.id } });
    res.status(201).json(patient);
  });

  return r;
}
