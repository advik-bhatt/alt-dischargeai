import type { SimplifiedSummary, Warning } from "../agents/types.js";
import { doseTokens } from "./fidelity.js";

const NUM_RE = /\d+(?:[.,]\d+)?/g;

function numbersIn(s: string): string[] {
  return (s.match(NUM_RE) ?? []).map((n) => n.replace(",", "."));
}

function medNames(s: SimplifiedSummary): string[] {
  return [...s.medications.new, ...s.medications.continue, ...s.medications.stop].map((m) => m.name.trim().toLowerCase());
}

/**
 * Compares the original English summary with the translation and its back-translation:
 * 1. medication names and doses in the translation must be verbatim copies;
 * 2. counts of medications, checklist items and precautions must match;
 * 3. every number in the original's medication lines must survive the round trip.
 * Any mismatch becomes a warning the patient page shows; nothing is silently dropped.
 */
export function checkTranslation(
  original: SimplifiedSummary,
  translation: SimplifiedSummary,
  backTranslation?: SimplifiedSummary,
): Warning[] {
  const warnings: Warning[] = [];

  const origMeds = [...original.medications.new, ...original.medications.continue];
  const transMeds = [...translation.medications.new, ...translation.medications.continue];
  if (medNames(original).join("|") !== medNames(translation).join("|")) {
    warnings.push({ code: "translation_med_names_changed", message: "Medication names in the translation differ from the original", field: "medications" });
  }
  for (let i = 0; i < Math.min(origMeds.length, transMeds.length); i++) {
    if (origMeds[i].dose.trim() !== transMeds[i].dose.trim()) {
      warnings.push({ code: "translation_dose_changed", message: `Dose for "${origMeds[i].name}" changed in translation`, name: origMeds[i].name, dose: origMeds[i].dose, field: "medications" });
    }
    const origNums = numbersIn(origMeds[i].howOften).join(",");
    const transNums = numbersIn(transMeds[i].howOften).join(",");
    if (origNums !== transNums) {
      warnings.push({ code: "translation_frequency_numbers_changed", message: `Numbers in how often to take "${origMeds[i].name}" changed in translation`, name: origMeds[i].name, field: "medications" });
    }
  }

  const counts: [string, number, number][] = [
    ["medications.new", original.medications.new.length, translation.medications.new.length],
    ["medications.continue", original.medications.continue.length, translation.medications.continue.length],
    ["medications.stop", original.medications.stop.length, translation.medications.stop.length],
    ["checklist", original.checklist.length, translation.checklist.length],
    ["returnPrecautions.call911", original.returnPrecautions.call911.length, translation.returnPrecautions.call911.length],
    ["returnPrecautions.goToER", original.returnPrecautions.goToER.length, translation.returnPrecautions.goToER.length],
    ["returnPrecautions.callClinic", original.returnPrecautions.callClinic.length, translation.returnPrecautions.callClinic.length],
    ["followUps", original.followUps.length, translation.followUps.length],
  ];
  for (const [field, a, b] of counts) {
    if (a !== b) warnings.push({ code: "translation_count_mismatch", message: `${field}: original has ${a} items, translation has ${b}`, field, value: b });
  }

  if (backTranslation) {
    const backMeds = [...backTranslation.medications.new, ...backTranslation.medications.continue];
    for (let i = 0; i < Math.min(origMeds.length, backMeds.length); i++) {
      const want = doseTokens(origMeds[i].dose);
      const got = new Set(doseTokens(backMeds[i].dose));
      for (const tok of want) {
        if (!got.has(tok)) {
          warnings.push({ code: "backtranslation_dose_mismatch", message: `Dose "${origMeds[i].dose}" for "${origMeds[i].name}" did not survive back-translation`, name: origMeds[i].name, dose: origMeds[i].dose, field: "medications" });
        }
      }
      if (origMeds[i].name.trim().toLowerCase() !== backMeds[i].name.trim().toLowerCase()) {
        warnings.push({ code: "backtranslation_name_mismatch", message: `Medication "${origMeds[i].name}" came back as "${backMeds[i].name}"`, name: origMeds[i].name, field: "medications" });
      }
    }
  }
  return warnings;
}
