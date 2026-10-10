import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AI_OUTPUT_KEYS, AiOutputSchema, publishedAiOutputSchema } from "../src/contracts/aiOutput.js";
import { loadAiOutputFixture } from "../src/pipeline/offline/fixtures.js";
import { checkTranslation } from "../src/pipeline/safetyChecks.js";

const CONTRACTS = join(import.meta.dirname, "..", "contracts");

describe("lane 3 contract (fixed JSON per language)", () => {
  it("the published JSON schema file is exactly what the zod contract generates", () => {
    const file = JSON.parse(readFileSync(join(CONTRACTS, "ai-output.schema.json"), "utf8"));
    expect(file).toEqual(publishedAiOutputSchema());
    expect(file.required).toEqual([...AI_OUTPUT_KEYS]);
    expect(file.additionalProperties).toBe(false);
  });

  it("the TypeScript type file names the same five keys", () => {
    const ts = readFileSync(join(CONTRACTS, "ai-output.ts"), "utf8");
    for (const key of AI_OUTPUT_KEYS) expect(ts).toMatch(new RegExp(`^\\s+${key}[?]?:`, "m"));
    expect(ts).not.toMatch(/^\s+summary[?]?:/m);
  });

  it("accepts every curated fixture and rejects any extra top-level key", () => {
    for (const id of ["example-1", "example-2", "example-3", "example-4", "example-5"]) {
      const out = loadAiOutputFixture(id, "en")!;
      expect(Object.keys(out).sort()).toEqual([...AI_OUTPUT_KEYS].sort());
      expect(out.medications.every((m) => ["new", "continue", "stop"].includes(m.status))).toBe(true);
      expect(out.warnings.every((w) => !w.tier || ["call911", "er", "clinic"].includes(w.tier))).toBe(true);
    }
    const extra = { ...loadAiOutputFixture("example-1", "en")!, summary: "nope" };
    expect(AiOutputSchema.safeParse(extra).success).toBe(false);
    const missing = { language: "en", steps: [], medications: [], followUps: [] };
    expect(AiOutputSchema.safeParse(missing).success).toBe(false);
  });

  it("the Example 1 fixtures in Spanish, Mandarin and Arabic validate and keep every name, dose, number, id, status and tier", () => {
    const en = loadAiOutputFixture("example-1", "en")!;
    for (const lang of ["es", "zh", "ar"]) {
      const out = loadAiOutputFixture("example-1", lang);
      expect(out, lang).toBeDefined();
      expect(out!.language).toBe(lang);
      expect(Object.keys(out!).sort()).toEqual([...AI_OUTPUT_KEYS].sort());
      expect(AiOutputSchema.safeParse(out).success).toBe(true);
      expect(checkTranslation(en, out!), lang).toEqual({ language: lang, passed: true, issues: [] });
      expect(out!.steps.map((s) => s.text)).not.toEqual(en.steps.map((s) => s.text));
      for (const m of out!.medications) {
        if (m.name === "Ibuprofen/other NSAIDs" || m.status === "continue") continue;
        expect(out!.steps.some((s) => s.text.toLowerCase().includes(m.name.toLowerCase())), `${lang} ${m.name}`).toBe(true);
      }
    }
  });
});
