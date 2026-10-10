import { describe, expect, it } from "vitest";
import { loadSimplifiedFixture } from "../src/agents/offline/fixtures.js";
import { checkTranslation } from "../src/verify/backtranslate.js";
import { checkFidelity, doseTokens, normalizeDoseText } from "../src/verify/fidelity.js";
import { exampleText } from "./helpers.js";

describe("fidelity check", () => {
  const source = exampleText("example-1-chf");

  it("passes the curated Example 1 fixture with zero warnings", () => {
    expect(checkFidelity(loadSimplifiedFixture("example-1"), source)).toEqual([]);
  });

  it("passes all five curated fixtures against their sources", () => {
    const pairs: [string, string][] = [
      ["example-1", "example-1-chf"],
      ["example-2", "example-2-sepsis-uti"],
      ["example-3", "example-3-hfpef-cellulitis"],
      ["example-4", "example-4-copd"],
      ["example-5", "example-5-endocarditis"],
    ];
    for (const [fixture, text] of pairs) {
      expect(checkFidelity(loadSimplifiedFixture(fixture), exampleText(text)), fixture).toEqual([]);
    }
  });

  it("catches an injected wrong dose (Furosemide 80 mg)", () => {
    const s = loadSimplifiedFixture("example-1");
    s.medications.new[0].dose = "80 mg";
    const warnings = checkFidelity(s, source);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "dose_not_in_source", name: "Furosemide", dose: "80 mg" });
  });

  it("catches an invented medication", () => {
    const s = loadSimplifiedFixture("example-1");
    s.medications.continue.push({ name: "Warfarin", dose: "5 mg", howOften: "daily", why: "x" });
    const warnings = checkFidelity(s, source);
    expect(warnings.map((w) => w.code)).toEqual(["med_not_in_source"]);
  });

  it("normalises units, spacing, ratio and decimal doses", () => {
    expect(normalizeDoseText("Furosemide 40 milligrams")).toBe("furosemide 40mg");
    expect(doseTokens("875 / 125 mg")).toEqual(["875/125mg"]);
    expect(doseTokens("0.4 MG")).toEqual(["0.4mg"]);
    expect(doseTokens("200 mcg")).toEqual(["200mcg"]);
    expect(doseTokens("as needed")).toEqual([]);
    expect(checkFidelity(
      { ...loadSimplifiedFixture("example-1"), medications: { new: [{ name: "furosemide", dose: "40 MILLIGRAMS", howOften: "", why: "" }], continue: [], stop: [] } },
      source,
    )).toEqual([]);
  });

  it("back-translation check flags a changed dose and a changed medication name", () => {
    const original = loadSimplifiedFixture("example-1");
    const translation = structuredClone(original);
    translation.language = "es";
    expect(checkTranslation(original, translation, structuredClone(original))).toEqual([]);

    const bad = structuredClone(translation);
    bad.medications.new[0].dose = "400 mg";
    bad.medications.new[1].name = "Losartán";
    const warnings = checkTranslation(original, bad, undefined);
    expect(warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["translation_dose_changed", "translation_med_names_changed"]));

    const back = structuredClone(original);
    back.medications.new[0].dose = "4 mg";
    expect(checkTranslation(original, translation, back).map((w) => w.code)).toContain("backtranslation_dose_mismatch");
  });
});
