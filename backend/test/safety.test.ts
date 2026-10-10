import { describe, expect, it } from "vitest";
import { loadAiOutputFixture } from "../src/pipeline/offline/fixtures.js";
import {
  canonicalFrequency,
  checkTranslation,
  doseTokens,
  durationDays,
  extractSourceMedications,
  frequencyNumbersChanged,
  normalizeDoseText,
  runSafetyChecks,
} from "../src/pipeline/safetyChecks.js";
import { exampleText, transcriptFixture } from "./helpers.js";

const PAIRS: [string, string][] = [
  ["example-1", "example-1-chf"],
  ["example-2", "example-2-sepsis-uti"],
  ["example-3", "example-3-hfpef-cellulitis"],
  ["example-4", "example-4-copd"],
  ["example-5", "example-5-endocarditis"],
];

describe("safety checks (never drop meds, doses, times)", () => {
  const source = exampleText("example-1-chf");

  it("extracts every medication, dose and frequency from the Example 1 source", () => {
    const meds = extractSourceMedications(source);
    const byName = Object.fromEntries(meds.map((m) => [m.name.toLowerCase(), m]));
    expect(byName["furosemide"]).toMatchObject({ doseTokens: ["40mg"], frequency: "1x/day", section: "new" });
    expect(byName["amoxicillin-clavulanate"]).toMatchObject({ doseTokens: ["875/125mg"], frequency: "2x/day", durationDays: 3 });
    expect(byName["atorvastatin"]).toMatchObject({ doseTokens: ["40mg"], frequency: "nightly", section: "continue" });
    expect(byName["lisinopril"]).toMatchObject({ section: "stop" });
    expect(byName["spironolactone"]).toMatchObject({ section: "stop" });
    expect(meds.length).toBe(11);
  });

  it("extracts medications from prose with no headings (a dictation transcript)", () => {
    const meds = extractSourceMedications(transcriptFixture());
    const names = meds.map((m) => m.name);
    expect(names).toEqual(expect.arrayContaining(["Furosemide", "Losartan", "Empagliflozin", "Amoxicillin-clavulanate", "Metoprolol succinate", "Apixaban", "Atorvastatin", "Metformin"]));
    expect(meds.find((m) => m.name === "Metformin")).toMatchObject({ doseTokens: ["500mg"], frequency: "2x/day", via: "prose" });
    expect(names).not.toContain("Creatinine");
  });

  it("passes all five curated fixtures against their sources with nothing dropped or unsupported", () => {
    for (const [fixture, text] of PAIRS) {
      const r = runSafetyChecks(exampleText(text), loadAiOutputFixture(fixture, "en")!);
      expect(r.dropped, `${fixture} dropped`).toEqual([]);
      expect(r.unsupported, `${fixture} unsupported`).toEqual([]);
      expect(r.passed).toBe(true);
      expect(r.verified.length).toBeGreaterThanOrEqual(5);
      expect(r.reason).toBeUndefined();
    }
  });

  it("blocks a dropped medication and names what is missing", () => {
    const out = loadAiOutputFixture("example-1", "en")!;
    out.medications = out.medications.filter((m) => m.name !== "Apixaban");
    const r = runSafetyChecks(source, out);
    expect(r.passed).toBe(false);
    expect(r.dropped).toEqual([expect.objectContaining({ name: "Apixaban", missing: ["medication"] })]);
    expect(r.reason).toBe("safety_check_failed dropped=1 unsupported=0");
  });

  it("blocks a changed dose (Furosemide 80 mg) in both directions", () => {
    const out = loadAiOutputFixture("example-1", "en")!;
    out.medications[0].dose = "80 mg";
    out.steps[0].text = "Take Furosemide 80 mg once a day";
    const r = runSafetyChecks(source, out);
    expect(r.dropped).toEqual([expect.objectContaining({ name: "Furosemide", missing: ["dose"] })]);
    expect(r.unsupported).toEqual([expect.objectContaining({ name: "Furosemide", dose: "80 mg", problem: "dose_not_in_source" })]);
    expect(r.passed).toBe(false);
  });

  it("blocks a changed frequency and a dropped duration", () => {
    const out = loadAiOutputFixture("example-1", "en")!;
    const apix = out.medications.find((m) => m.name === "Apixaban")!;
    apix.howOften = "once a day";
    const amox = out.medications.find((m) => m.name === "Amoxicillin-clavulanate")!;
    amox.howOften = "twice a day by mouth";
    out.steps = out.steps.filter((s) => s.id !== "med-4");
    const r = runSafetyChecks(source, out);
    const names = Object.fromEntries(r.dropped.map((d) => [d.name, d.missing]));
    expect(names["Apixaban"]).toEqual(["frequency"]);
    expect(names["Amoxicillin-clavulanate"]).toEqual(["duration"]);
  });

  it("blocks an invented medication", () => {
    const out = loadAiOutputFixture("example-1", "en")!;
    out.medications.push({ name: "Warfarin", dose: "5 mg", howOften: "once a day", status: "new", why: "x" });
    const r = runSafetyChecks(source, out);
    expect(r.unsupported).toEqual([expect.objectContaining({ name: "Warfarin", problem: "medication_not_in_source" })]);
    expect(r.dropped).toEqual([]);
  });

  it("normalises units, spacing, ratio and decimal doses, frequencies and durations", () => {
    expect(normalizeDoseText("Furosemide 40 milligrams")).toBe("furosemide 40mg");
    expect(doseTokens("875 / 125 mg")).toEqual(["875/125mg"]);
    expect(doseTokens("0.4 MG")).toEqual(["0.4mg"]);
    expect(doseTokens("200 mcg")).toEqual(["200mcg"]);
    expect(doseTokens("as needed")).toEqual([]);
    expect(canonicalFrequency("twice daily for 3 additional days")).toBe("2x/day");
    expect(canonicalFrequency("once a day by mouth")).toBe("1x/day");
    expect(canonicalFrequency("four times daily")).toBe("4x/day");
    expect(canonicalFrequency("nightly")).toBe("nightly");
    expect(canonicalFrequency("as needed for mild pain")).toBe("prn");
    expect(canonicalFrequency("as instructed")).toBeUndefined();
    expect(durationDays("for 3 additional days")).toBe(3);
    expect(durationDays("for 2 weeks")).toBe(14);
  });

  it("checks a translation for verbatim names, doses and numbers and the same structure", () => {
    const en = loadAiOutputFixture("example-1", "en")!;
    const es = loadAiOutputFixture("example-1", "es")!;
    expect(checkTranslation(en, es)).toEqual({ language: "es", passed: true, issues: [] });

    const bad = structuredClone(es);
    bad.medications[0].dose = "400 mg";
    bad.medications[1].name = "Losartán";
    bad.medications[3].howOften = "dos veces al día por 30 días más";
    bad.warnings.pop();
    const r = checkTranslation(en, bad);
    expect(r.passed).toBe(false);
    expect(r.issues).toEqual(expect.arrayContaining(["medication_dose_changed:0", "medication_name_changed:1", "medication_frequency_numbers_changed:3", "warning_count_changed"]));
  });

  it("frequency numbers: a digit for once/twice is fine, a lost, changed or invented number is not (seen live on Bedrock for Mandarin)", () => {
    expect(frequencyNumbersChanged("By mouth once daily", "每日口服1次")).toBe(false);
    expect(frequencyNumbersChanged("Twice daily", "每日2次")).toBe(false);
    expect(frequencyNumbersChanged("By mouth twice daily for 3 additional days", "每日口服2次，再服3天")).toBe(false);
    expect(frequencyNumbersChanged("twice a day by mouth for 3 more days", "dos veces al día por 30 días más")).toBe(true);
    expect(frequencyNumbersChanged("twice a day by mouth for 3 more days", "dos veces al día por la boca")).toBe(true);
    expect(frequencyNumbersChanged("once daily", "每日1次，连续10天")).toBe(true);
    expect(frequencyNumbersChanged("0.4 mg once daily", "0.4 mg una vez al día")).toBe(false);
  });
});
