import { describe, expect, it } from "vitest";
import { AI_OUTPUT_KEYS, AiOutputSchema } from "../src/contracts/aiOutput.js";
import { languageName, normalizeLanguage, resolveLanguages } from "../src/pipeline/languages.js";
import { ruleBasedSimplify } from "../src/pipeline/offline/rules.js";
import { runPipeline } from "../src/pipeline/runPipeline.js";
import { OfflineSimplifier } from "../src/pipeline/simplify.js";
import { OfflineSpeechToText } from "../src/pipeline/speechToText.js";
import { OfflineTranslator } from "../src/pipeline/translate.js";
import { exampleText } from "./helpers.js";

const deps = { speechToText: new OfflineSpeechToText(), simplifier: new OfflineSimplifier(), translator: new OfflineTranslator() };

describe("lane 3 pipeline (offline providers)", () => {
  it("produces the fixed JSON per language for Example 1 with the curated fixtures", async () => {
    const r = await runPipeline({ rawText: exampleText("example-1-chf"), languages: ["es", "zh"] }, deps);
    expect(r.verified).toBe(true);
    expect(Object.keys(r.perLanguage).sort()).toEqual(["en", "es", "zh"]);
    for (const out of Object.values(r.perLanguage)) {
      expect(Object.keys(out).sort()).toEqual([...AI_OUTPUT_KEYS].sort());
      expect(AiOutputSchema.safeParse(out).success).toBe(true);
    }
    expect(r.perLanguage.es.steps[0].text).toMatch(/Tome Furosemide 40 mg/);
    expect(r.perLanguage.zh.medications.map((m) => `${m.name}|${m.dose}`)).toEqual(r.perLanguage.en.medications.map((m) => `${m.name}|${m.dose}`));
    expect(r.safety.passed).toBe(true);
    expect(r.safety.translations.map((t) => [t.language, t.passed])).toEqual([
      ["es", true],
      ["zh", true],
    ]);
    expect(r.meta).toMatchObject({ provider: "offline", fixture: "example-1", skipped: [] });
  });

  it("transcribes audio with the offline speech-to-text and simplifies the transcript", async () => {
    const r = await runPipeline({ audio: { audio: Buffer.from("RIFF fake wav"), mimeType: "audio/wav" }, languages: ["en"] }, deps);
    expect(r.transcript?.provider).toBe("offline");
    expect(r.sourceText).toContain("Furosemide 40 mg");
    expect(r.perLanguage.en.medications.map((m) => m.name)).toContain("Furosemide");
    expect(r.safety.passed).toBe(true);
  });

  it("joins pasted text and a transcript when both are given", async () => {
    const r = await runPipeline({ rawText: "Discharge note.", audio: { audio: Buffer.from("x"), mimeType: "audio/wav" }, languages: ["en"] }, deps);
    expect(r.sourceText.startsWith("Discharge note.")).toBe(true);
    expect(r.sourceText).toContain("Furosemide 40 mg");
  });

  it("falls back to rule-based extraction for text that matches no fixture and still passes safety", async () => {
    const text = [
      "Discharge diagnoses:",
      "• Community-acquired pneumonia",
      "• Hypertension",
      "Discharge Medications",
      "New medications",
      "• Azithromycin 250 mg by mouth once daily for 4 additional days.",
      "Continue",
      "• Amlodipine 10 mg daily.",
      "Stopped/held",
      "• Lisinopril — held pending blood pressure recheck.",
      "Discharge Instructions",
      "• Follow up with primary care within 1 week.",
      "• Weigh yourself every morning.",
      "Return Precautions",
      "• Chest pain.",
      "• Fever above 101 F.",
    ].join("\n");
    const r = await runPipeline({ rawText: text, languages: ["es"] }, deps);
    expect(r.meta.model).toBe("rules");
    const en = r.perLanguage.en;
    expect(en.medications).toEqual([
      expect.objectContaining({ name: "Azithromycin", dose: "250 mg", status: "new", howOften: "once a day by mouth for 4 more days" }),
      expect.objectContaining({ name: "Amlodipine", dose: "10 mg", status: "continue" }),
      expect.objectContaining({ name: "Lisinopril", status: "stop" }),
    ]);
    expect(en.followUps[0]).toMatchObject({ who: "primary care", when: "within 1 week" });
    expect(en.warnings).toEqual([
      { text: "Chest pain.", tier: "call911" },
      { text: "Fever above 101 F.", tier: "er" },
    ]);
    expect(en.steps.map((s) => s.id)).toEqual(en.steps.map((_, i) => `step-${i + 1}`));
    expect(r.safety.passed).toBe(true);
    expect(r.perLanguage.es.steps[0].text).toBe("Tome Azithromycin 250 mg una vez al día por la boca por 4 días más");
    expect(r.perLanguage.es.medications[0]).toMatchObject({ name: "Azithromycin", dose: "250 mg" });
  });

  it("blocks the record and skips translation when the simplifier drops a medication", async () => {
    const dropping = {
      name: "dropping",
      async simplify(input: { text: string }) {
        const r = await deps.simplifier.simplify(input);
        r.output.medications = r.output.medications.filter((m) => m.name !== "Metformin");
        return r;
      },
    };
    const r = await runPipeline({ rawText: exampleText("example-1-chf"), languages: ["es"] }, { ...deps, simplifier: dropping });
    expect(r.verified).toBe(false);
    expect(Object.keys(r.perLanguage)).toEqual(["en"]);
    expect(r.safety.dropped).toEqual([expect.objectContaining({ name: "Metformin" })]);
    expect(r.safety.reason).toBe("safety_check_failed dropped=1 unsupported=0");
    expect(r.meta.skipped).toEqual([{ language: "es", reason: "blocked_by_safety_checks" }]);
  });

  it("keeps a translation out when it changes a dose", async () => {
    const tampering = {
      name: "tampering",
      async translate(input: Parameters<OfflineTranslator["translate"]>[0]) {
        const r = await deps.translator.translate(input);
        r.output.medications[0].dose = "400 mg";
        return r;
      },
    };
    const r = await runPipeline({ rawText: exampleText("example-1-chf"), languages: ["es"] }, { ...deps, translator: tampering });
    expect(r.verified).toBe(true);
    expect(Object.keys(r.perLanguage)).toEqual(["en"]);
    expect(r.meta.skipped[0]).toMatchObject({ language: "es", reason: expect.stringContaining("medication_dose_changed:0") });
  });

  it("rule-based simplify returns the exact contract keys and nothing else", () => {
    const out = ruleBasedSimplify("New medications\n• Furosemide 40 mg once daily.\n");
    expect(Object.keys(out).sort()).toEqual([...AI_OUTPUT_KEYS].sort());
    expect(AiOutputSchema.safeParse(out).success).toBe(true);
  });

  it("normalises language codes and names without a fixed list", () => {
    expect(normalizeLanguage("Spanish")).toBe("es");
    expect(normalizeLanguage("ES-mx")).toBe("es-MX");
    expect(normalizeLanguage("zh")).toBe("zh");
    expect(normalizeLanguage("Mandarin")).toBe("zh");
    expect(normalizeLanguage("??")).toBeUndefined();
    expect(languageName("ar")).toBe("Arabic");
    expect(languageName("ht")).toBe("Haitian Creole");
    expect(resolveLanguages("es", ["ar", "es", "en"])).toEqual({ primary: "es", languages: ["en", "es", "ar"] });
    expect(resolveLanguages(undefined, [])).toEqual({ primary: "en", languages: ["en"] });
  });
});
