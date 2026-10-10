import { z } from "zod";

/**
 * Lane 3 contract: the fixed JSON the AI pipeline returns per language. Top-level keys are exactly
 * `language`, `steps`, `medications`, `followUps`, `warnings`; nothing else is accepted (`.strict()`).
 * Published for the other lanes as `contracts/ai-output.schema.json` (generated from this file by
 * `npm run export-contract`) and `contracts/ai-output.ts` (plain TypeScript type, no dependencies).
 */

export const StepSchema = z
  .object({
    id: z.string().min(1).describe("Stable short id, e.g. step-1"),
    text: z.string().min(1).describe("One thing the patient does, at a 5th-grade reading level"),
  })
  .strict();

export const MedicationStatusSchema = z.enum(["new", "continue", "stop"]);

export const MedicationSchema = z
  .object({
    name: z.string().min(1).describe("Drug name exactly as written in the source"),
    dose: z.string().describe("Dose exactly as written in the source, e.g. '40 mg'. Empty string when the source gives none."),
    howOften: z.string().describe("How often and how to take it, in plain words; every number copied from the source"),
    status: MedicationStatusSchema.describe("new = start it, continue = keep taking it, stop = stopped or on hold"),
    why: z.string().describe("Why, in plain words"),
  })
  .strict();

export const FollowUpSchema = z
  .object({
    who: z.string().min(1).describe("Who to see, e.g. 'Primary care doctor'"),
    when: z.string().min(1).describe("When, in plain words, e.g. 'within 1 week'"),
    why: z.string().min(1).describe("Why, in plain words"),
  })
  .strict();

export const WarningTierSchema = z.enum(["call911", "er", "clinic"]);

export const WarningSchema = z
  .object({
    text: z.string().min(1).describe("A warning sign, in plain words"),
    tier: WarningTierSchema.optional().describe("call911 = life-threatening, er = same-day care, clinic = call the care team"),
  })
  .strict();

export const AiOutputSchema = z
  .object({
    language: z.string().min(2).describe("BCP-47 code of the text, e.g. en, es, zh, ar"),
    steps: z.array(StepSchema),
    medications: z.array(MedicationSchema),
    followUps: z.array(FollowUpSchema),
    warnings: z.array(WarningSchema),
  })
  .strict();

export type AiOutput = z.infer<typeof AiOutputSchema>;
export type Step = z.infer<typeof StepSchema>;
export type Medication = z.infer<typeof MedicationSchema>;
export type MedicationStatus = z.infer<typeof MedicationStatusSchema>;
export type FollowUp = z.infer<typeof FollowUpSchema>;
export type Warning = z.infer<typeof WarningSchema>;
export type WarningTier = z.infer<typeof WarningTierSchema>;

export const AI_OUTPUT_KEYS = ["language", "steps", "medications", "followUps", "warnings"] as const;

/** JSON Schema (draft 2020-12) of the contract, for Bedrock/Anthropic structured output and for the published file. */
export function aiOutputJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(AiOutputSchema) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

/** The published file content: the same schema with `$id`, `title` and `$schema` for editors and validators. */
export function publishedAiOutputSchema(): Record<string, unknown> {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://github.com/sameerj05/DischargeAI/backend/contracts/ai-output.schema.json",
    title: "DischargeAI AI output (per language)",
    description:
      "Lane 3 contract: raw clinician text in, this JSON out, once per language. Top-level keys are exactly language, steps, medications, followUps, warnings.",
    ...aiOutputJsonSchema(),
  };
}
