import { Router } from "express";
import { z } from "zod";
import type { AppContext } from "../context.js";
import { toContractPatient } from "../db/repos/patients.js";

const NewPatientBody = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD"),
  zipCode: z.string().trim().min(3).max(12),
  email: z.string().trim().email(),
  phone: z.string().trim().min(5).max(30),
  caregiverEmail: z.string().trim().email().nullable().optional(),
  caregiverName: z.string().trim().min(1).max(160).nullable().optional(),
  preferredLanguage: z.string().trim().min(2).max(10).optional(),
});

/** POST /patients takes the camelCase body or the contract's own spellings (FirstName, DOB, phoneNumber, ...). */
function normalizeNewPatient(body: Record<string, unknown>): Record<string, unknown> {
  const aliases: Record<string, string> = { ID: "id", FirstName: "firstName", LastName: "lastName", DOB: "dateOfBirth", ZipCode: "zipCode", phoneNumber: "phone" };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[aliases[k] ?? k] = v;
  if (out.caregiverEmail === "") out.caregiverEmail = null;
  if (out.caregiverName === "") out.caregiverName = null;
  return out;
}

/**
 * The team contract: GET /patients "gets list of patients from the db" and returns ID, DOB,
 * FirstName, LastName, ZipCode, email, phoneNumber, caregiverEmail, caregiverName, exactly those
 * keys. GET /patients/:id (one patient plus the active link) and POST /patients (seeding) stay.
 */
export function patientsRouter(ctx: AppContext): Router {
  const r = Router();

  r.get("/patients", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q : undefined;
    const patients = await ctx.patients.list(q);
    res.json({ patients: patients.map(toContractPatient) });
  });

  r.get("/patients/:id", async (req, res) => {
    const p = await ctx.patients.getById(req.params.id);
    if (!p) {
      res.status(404).json({ statusCode: 404, error: "patient_not_found", message: "Unknown patient" });
      return;
    }
    const link = await ctx.activeLinks.activeForPatient(p.id, ctx.clock.nowIso());
    res.json({
      ...toContractPatient(p),
      preferredLanguage: p.preferredLanguage,
      activeLink: link ? { sumId: link.sumId, link: ctx.patientUrl(link.sumId), status: link.status, createdAt: link.createdAt, expiresAt: link.expiresAt, languages: link.languages } : null,
    });
  });

  r.post("/patients", async (req, res) => {
    const body = NewPatientBody.parse(normalizeNewPatient((req.body ?? {}) as Record<string, unknown>));
    const patient = await ctx.patients.create(body, ctx.clock.nowIso());
    await ctx.audit.append({ event: "patient.created", actor: "provider", at: ctx.clock.nowIso(), details: { patientId: patient.id } });
    res.status(201).json(toContractPatient(patient));
  });

  return r;
}
