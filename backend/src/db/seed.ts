import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditRepo } from "./repos/audit.js";
import type { NewPatient, PatientsRepo } from "./repos/patients.js";

export const SEED_FILE = join(import.meta.dirname, "..", "..", "fixtures", "patients.seed.json");

/**
 * Writes the six synthetic patients (pt-0001 to pt-0006, @example.test addresses) into the LOCAL
 * SQLite patients table, skipping any already there. Never runs on its own: only `npm run seed` and
 * the test suite call it, and it refuses MySQL, where the table is the team's real patient list.
 */
export async function seedPatients(patients: PatientsRepo, audit: AuditRepo, nowIso: () => string, file: string = SEED_FILE): Promise<number> {
  if (patients.dialect !== "sqlite") {
    throw new Error(`Refusing to seed synthetic patients into MySQL ("${patients.table}" there is the team's real patient table). Seeding is for local SQLite only.`);
  }
  const seed = JSON.parse(readFileSync(file, "utf8")) as NewPatient[];
  let added = 0;
  for (const p of seed) {
    if (await patients.getById(p.id)) continue;
    await patients.insertLocal(p);
    await audit.append({ event: "patient.created", actor: "system", at: nowIso(), details: { patientId: p.id, seed: true } });
    added += 1;
  }
  return added;
}
