import type { SimplifiedSummary, Warning } from "../agents/types.js";

/**
 * Deterministic fidelity check, run after any simplifier (LLM or not). Every medication name and every
 * numeric dose in the structured output must appear in the source text, case-insensitively and with
 * units normalised. A miss is a warning, the job is flagged needs_review, and the patient page shows it.
 * Unit table adapted from the dosis project (MIT), see docs/research.md.
 */

const UNIT_ALIASES: [RegExp, string][] = [
  [/\b(milligrams?|mgs?)\b/g, "mg"],
  [/\b(micrograms?|mcg|ug|µg)\b/g, "mcg"],
  [/\b(grams?|gm|g)\b/g, "g"],
  [/\b(millilit(?:er|re)s?|ml|mls)\b/g, "ml"],
  [/\b(international units?|iu|units?|u)\b/g, "units"],
  [/\b(milliequivalents?|meq)\b/g, "meq"],
  [/\b(percent|%)/g, "%"],
];

export function normalizeDoseText(text: string): string {
  let t = text
    .toLowerCase()
    .replace(/-\s*\r?\n\s*/g, "-") // words hyphenated across a line break
    .replace(/\s+/g, " ");
  for (const [re, unit] of UNIT_ALIASES) t = t.replace(re, unit);
  // "875 / 125 mg" -> "875/125mg", "40 mg" -> "40mg", "0.4 mg" -> "0.4mg"
  t = t.replace(/(\d)\s*\/\s*(\d)/g, "$1/$2");
  t = t.replace(/(\d(?:\.\d+)?)\s+(mg|mcg|g|ml|units|meq|%)\b/g, "$1$2");
  return t;
}

const DOSE_TOKEN_RE = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(mg|mcg|g|ml|units|meq|%)\b/g;

/** Numeric dose tokens in normalised form, e.g. ["40mg"], ["875/125mg"], ["0.4mg"]. */
export function doseTokens(dose: string): string[] {
  const norm = normalizeDoseText(dose);
  const out: string[] = [];
  for (const m of norm.matchAll(DOSE_TOKEN_RE)) out.push(`${m[1]}${m[2]}`);
  return out;
}

function nameCandidates(name: string): string[] {
  const base = name.toLowerCase().replace(/\s+/g, " ").trim();
  const candidates = new Set<string>([base]);
  const noParen = base.replace(/\s*\([^)]*\)\s*/g, " ").replace(/\s+/g, " ").trim();
  if (noParen) candidates.add(noParen);
  for (const part of noParen.split(/\s*[/,]\s*/)) if (part.length >= 4) candidates.add(part.trim());
  const first = noParen.split(" ")[0];
  if (first && first.length >= 5) candidates.add(first);
  return [...candidates].filter(Boolean);
}

export function medicationNameInSource(name: string, normalizedSource: string): boolean {
  return nameCandidates(name).some((c) => normalizedSource.includes(c));
}

export function checkFidelity(summary: SimplifiedSummary, sourceText: string): Warning[] {
  const source = normalizeDoseText(sourceText);
  const warnings: Warning[] = [];
  const groups: ["new" | "continue" | "stop", { name: string; dose?: string }[]][] = [
    ["new", summary.medications.new],
    ["continue", summary.medications.continue],
    ["stop", summary.medications.stop],
  ];
  for (const [group, meds] of groups) {
    for (const med of meds) {
      if (!medicationNameInSource(med.name, source)) {
        warnings.push({
          code: "med_not_in_source",
          message: `Medication "${med.name}" (${group}) does not appear in the source text`,
          name: med.name,
          field: `medications.${group}`,
        });
        continue;
      }
      if (med.dose) {
        for (const token of doseTokens(med.dose)) {
          if (!source.includes(token)) {
            warnings.push({
              code: "dose_not_in_source",
              message: `Dose "${med.dose}" for "${med.name}" does not appear in the source text`,
              name: med.name,
              dose: med.dose,
              field: `medications.${group}`,
            });
          }
        }
      }
    }
  }
  return warnings;
}
