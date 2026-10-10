/**
 * DischargeAI, lane 3 contract: the fixed JSON the AI pipeline returns per language.
 * Plain TypeScript, no dependencies, so the frontend can copy this file as is.
 * The machine-readable version is ai-output.schema.json next to this file; both are generated
 * from backend/src/contracts/aiOutput.ts (zod), which the backend validates every result against.
 */

export type MedicationStatus = "new" | "continue" | "stop";
export type WarningTier = "call911" | "er" | "clinic";

export interface Step {
  /** Stable short id, e.g. "step-1". */
  id: string;
  /** One thing the patient does, at a 5th-grade reading level. */
  text: string;
}

export interface Medication {
  /** Drug name exactly as written in the source. */
  name: string;
  /** Dose exactly as written in the source, e.g. "40 mg". Empty string when the source gives none. */
  dose: string;
  /** How often and how to take it, in plain words; every number copied from the source. */
  howOften: string;
  /** new = start it, continue = keep taking it, stop = stopped or on hold. */
  status: MedicationStatus;
  /** Why, in plain words. */
  why: string;
}

export interface FollowUp {
  who: string;
  when: string;
  why: string;
}

export interface Warning {
  text: string;
  /** call911 = life-threatening, er = same-day care, clinic = call the care team. */
  tier?: WarningTier;
}

/** Top-level keys are exactly these five. */
export interface AiOutput {
  /** BCP-47 code of the text, e.g. "en", "es", "zh", "ar". */
  language: string;
  steps: Step[];
  medications: Medication[];
  followUps: FollowUp[];
  warnings: Warning[];
}

/** What GET /p/:token returns: the per-language object plus the record's expiry and the languages it holds. */
export interface PatientRecordResponse extends AiOutput {
  /** ISO-8601; the record and its audio are deleted at this moment (DynamoDB TTL + S3 lifecycle). */
  expiresAt: string;
  /** Languages produced at synthesis; any of them can be requested with ?language=. */
  availableLanguages: string[];
  /** Free text the provider typed at ingest, when any. */
  patientLabel?: string;
}
