import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PatientsRepo, NewPatient } from "./repos/patients.js";
import type { AuditRepo } from "./repos/audit.js";

export const SEED_FILE = join(import.meta.dirname, "..", "..", "fixtures", "patients.seed.json");

/** Idempotent: inserts the synthetic patients that are not present yet. Returns how many were added. */
export async function seedPatients(
  patients: PatientsRepo,
  audit: AuditRepo,
  nowIso: () => string,
  file: string = SEED_FILE,
): Promise<number> {
  const seed = JSON.parse(readFileSync(file, "utf8")) as (NewPatient & { id: string })[];
  let added = 0;
  for (const p of seed) {
    if (await patients.getById(p.id)) continue;
    await patients.create(p, nowIso());
    await audit.append({ event: "patient.created", actor: "system", at: nowIso(), details: { patientId: p.id, seed: true } });
    added += 1;
  }
  return added;
}
