import type { AiOutput, Medication } from "../contracts/aiOutput.js";
import { readabilityGrade } from "./readability.js";

/**
 * Lane 3, "Safety checks (never drop meds, doses, times)". Deterministic, no model involved.
 *
 * Direction 1 (the diagram's rule): every medication the SOURCE names, with its dose and its
 * frequency/duration, must appear in the OUTPUT. Anything missing is `dropped`.
 * Direction 2 (hallucination guard): every medication name and numeric dose in the OUTPUT must
 * appear in the SOURCE. Anything else is `unsupported`.
 * Either list non-empty => `passed: false`; the record is blocked as `needs_review` with a reason
 * that carries counts only (no PHI). The detailed result is stored encrypted on the record and
 * returned by POST /synthesize for the provider.
 */

export interface SourceMedication {
  name: string;
  /** Normalised dose tokens, e.g. ["40mg"], ["875/125mg"]; empty when the source gives no dose. */
  doseTokens: string[];
  dose?: string;
  frequency?: string;
  durationDays?: number;
  section?: "new" | "continue" | "stop";
  /** Where it was found: a bulleted medication section, or a "<Name> <dose>" mention in prose. */
  via: "section" | "prose";
}

export interface DroppedItem {
  name: string;
  missing: ("medication" | "dose" | "frequency" | "duration")[];
  expected: { dose?: string; frequency?: string; durationDays?: number };
  found?: { dose?: string; frequency?: string };
}

export interface UnsupportedItem {
  name: string;
  dose?: string;
  problem: "medication_not_in_source" | "dose_not_in_source";
}

export interface SafetyResult {
  passed: boolean;
  checkedAt: string;
  method: "deterministic";
  sourceMedicationCount: number;
  outputMedicationCount: number;
  verified: { name: string; dose?: string; frequency?: string; durationDays?: number; matchedOutput: string }[];
  dropped: DroppedItem[];
  unsupported: UnsupportedItem[];
  /** Flesch-Kincaid grade of the steps text; informational, never blocks. */
  readabilityGrade?: number;
  /** Counts only, safe to store in plaintext and to log. */
  reason?: string;
}

/* ---------- normalisation helpers ---------- */

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
    .replace(/-\s*\r?\n\s*/g, "-")
    .replace(/\s+/g, " ");
  for (const [re, unit] of UNIT_ALIASES) t = t.replace(re, unit);
  t = t.replace(/(\d)\s*\/\s*(\d)/g, "$1/$2");
  t = t.replace(/(\d(?:\.\d+)?)\s+(mg|mcg|g|ml|units|meq|%)\b/g, "$1$2");
  return t;
}

const DOSE_TOKEN_RE = /(\d+(?:\.\d+)?(?:\/\d+(?:\.\d+)?)?)(mg|mcg|g|ml|units|meq|%)\b/g;

/** Numeric dose tokens in normalised form, e.g. ["40mg"], ["875/125mg"], ["0.4mg"]. */
export function doseTokens(dose: string): string[] {
  const out: string[] = [];
  for (const m of normalizeDoseText(dose).matchAll(DOSE_TOKEN_RE)) out.push(`${m[1]}${m[2]}`);
  return out;
}

/**
 * Canonical frequency of a free-text "how often" phrase, English only (the check runs on the
 * English output; translations are checked for verbatim names, doses and numbers instead).
 */
export function canonicalFrequency(text: string): string | undefined {
  const l = text.toLowerCase();
  if (/\b(as needed|when needed|only when|if needed|prn)\b/.test(l)) return "prn";
  if (/\b(four times (a|per|each) day|four times daily|4 times (a|per) day|qid)\b/.test(l)) return "4x/day";
  if (/\b(three times (a|per|each) day|three times daily|3 times (a|per) day|tid)\b/.test(l)) return "3x/day";
  if (/\b(twice (a|per|each) day|twice daily|two times (a|per) day|2 times (a|per) day|bid)\b/.test(l)) return "2x/day";
  if (/\bevery other day\b/.test(l)) return "every-other-day";
  if (/\b(once (a|per|each) week|weekly|every week)\b/.test(l)) return "weekly";
  if (/\b(nightly|at bedtime|every night|each night|qhs|at night)\b/.test(l)) return "nightly";
  if (/\b(once (a|per|each) day|once daily|daily|every day|each day|every morning|each morning|once in the morning|qd)\b/.test(l)) return "1x/day";
  return undefined;
}

export function durationDays(text: string): number | undefined {
  const m = /\bfor\s+(\d+)\s+(?:additional\s+|more\s+)?(day|week)s?\b/i.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return m[2].toLowerCase() === "week" ? n * 7 : n;
}

function normName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*/g, " ")
    .replace(/[^a-z0-9/ -]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC_LEAD = /^(rescue|maintenance|previous|prior|home|other|any|all|duplicate|empiric|inpatient|chronic|short-acting|long-acting|lower-dose|higher-dose|new|old|usual|current)\b\s*/;
const CATEGORY_WORDS = new Set(["medications", "medication", "medicines", "medicine", "regimen", "inhaler", "therapy", "antibiotics", "antibiotic", "dose", "drugs", "meds", "inhalers", "diuretic"]);

/** Strips category adjectives; returns undefined when nothing drug-like is left ("Maintenance inhaler"). */
function specificDrugName(raw: string): string | undefined {
  let n = normName(raw);
  for (;;) {
    const next = n.replace(GENERIC_LEAD, "");
    if (next === n) break;
    n = next;
  }
  const first = n.split(" ")[0];
  if (!first || CATEGORY_WORDS.has(first)) return undefined;
  return n;
}

/** Candidates that count as "this medication is present": the whole name, each slash/comma part, the first significant word. */
export function nameCandidates(name: string): string[] {
  const base = normName(name);
  const out = new Set<string>();
  if (base) out.add(base);
  for (const part of base.split(/\s*[/,]\s*/)) if (part.length >= 4) out.add(part.trim());
  const first = base.split(" ")[0];
  if (first && first.length >= 5 && !GENERIC_LEAD.test(`${first} `)) out.add(first);
  return [...out].filter(Boolean);
}

function namesMatch(sourceName: string, outputName: string): boolean {
  const s = normName(sourceName);
  const o = normName(outputName);
  if (!s || !o) return false;
  if (o.includes(s) || s.includes(o)) return true;
  const sc = nameCandidates(sourceName);
  const oc = nameCandidates(outputName);
  return sc.some((c) => c.length >= 5 && o.includes(c)) || oc.some((c) => c.length >= 5 && s.includes(c));
}

/* ---------- source extraction ---------- */

const BULLET = /^\s*(?:[•\-*·]|\d+[.)])\s*/;
const DOSE_RE = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)\s*(mg|mcg|µg|ug|g|ml|units?|iu|%)\b/i;
const NAME_STOP = /\s+\b(as|for|at|by|once|twice|daily|nightly|every|with|while|to|in|if|and|or|after|until|per|that|which|when|iv|intravenous|through|via)\b/i;

type Section = "none" | "new" | "continue" | "stop" | "other";

function sectionFor(line: string, current: Section): Section {
  const l = line.trim().toLowerCase().replace(/[:\s]+$/, "");
  if (l.length > 45 || /[,.]$/.test(l)) return current;
  if (/^(new medications?|new|start|started)$/.test(l) || /^new medications?\b/.test(l)) return "new";
  if (/^(continue|continued|continue medications?|unchanged)$/.test(l) || /^continue\b/.test(l)) return "continue";
  if (/^(stopped|stop|held|stopped\/held|discontinued|stopped or held|stop\/hold)/.test(l)) return "stop";
  if (/^(discharge diagnos|hospital course|discharge instructions?|return precautions?|nursing|what nursing|admission diagnosis|patient:|discharge medications?)/.test(l)) return "other";
  return current;
}

function parseSectionLine(line: string): { name: string; dose?: string; rest: string } | undefined {
  const text = line.replace(BULLET, "").trim();
  if (!text) return undefined;
  const dash = text.split(/\s[—–-]\s/);
  if (dash.length > 1 && !DOSE_RE.test(dash[0])) {
    return { name: dash[0].trim(), rest: dash.slice(1).join(" ").trim() };
  }
  const m = DOSE_RE.exec(text);
  if (m && m.index > 0) {
    const name = text.slice(0, m.index).trim().replace(/[,:]$/, "");
    const rest = text.slice(m.index + m[0].length).trim().replace(/^[,:]\s*/, "");
    return { name, dose: m[0], rest };
  }
  const firstClause = text.split(/[,:(]/)[0].trim();
  const stop = NAME_STOP.exec(firstClause);
  const words = (stop ? firstClause.slice(0, stop.index) : firstClause).trim().split(/\s+/);
  const name = words.slice(0, Math.min(words.length, 4)).join(" ").replace(/\.$/, "");
  return { name, rest: text.slice(name.length).trim().replace(/^[,:]\s*/, "") };
}

/** Medications under New / Continue / Stopped headings, one bullet per line (wrapped lines re-joined). */
export function extractSectionMedications(text: string): SourceMedication[] {
  const lines = text.replace(/-\r?\n\s*/g, "-").split(/\r?\n/);
  const joined: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, "");
    const isBullet = BULLET.test(line);
    const isHeading = sectionFor(line, "none") !== "none";
    if (!isBullet && !isHeading && joined.length && BULLET.test(joined[joined.length - 1]) && line.trim()) {
      joined[joined.length - 1] += ` ${line.trim()}`;
    } else {
      joined.push(line);
    }
  }
  const out: SourceMedication[] = [];
  let section: Section = "none";
  for (const raw of joined) {
    const line = raw.trim();
    if (!line) continue;
    const next = sectionFor(line, section);
    if (next !== section) {
      section = next;
      continue;
    }
    if (section === "none" || section === "other" || !BULLET.test(line)) continue;
    const parsed = parseSectionLine(line);
    if (!parsed) continue;
    const name = specificDrugName(parsed.name);
    if (!name) continue;
    out.push({
      name: parsed.name.trim(),
      dose: parsed.dose,
      doseTokens: parsed.dose ? doseTokens(parsed.dose) : [],
      frequency: canonicalFrequency(parsed.rest),
      durationDays: durationDays(parsed.rest),
      section,
      via: "section",
    });
  }
  return out;
}

const NAME_WORD = /^[A-Z][A-Za-z-]{3,}$/;
const CONTINUATION = new Set(["succinate", "tartrate", "sodium", "potassium", "hydrochloride", "hcl", "xl", "er", "sr", "cr", "la", "xr", "acetate", "sulfate", "citrate", "calcium", "mesylate", "maleate", "besylate", "fumarate", "clavulanate"]);
const NOT_A_NAME = new Set(["Continue", "Continued", "New", "Start", "Started", "Take", "Stop", "Stopped", "Held", "Hold", "Medications", "Medication", "And", "With", "Plus", "Also", "Then", "Give", "Given", "Received", "Daily", "The", "Patient", "Discharge", "Prescribed"]);

/** "<Name> <dose>" mentions anywhere in prose (dictation transcripts have no headings). */
export function extractProseMedications(text: string): SourceMedication[] {
  const flat = text.replace(/-\r?\n\s*/g, "-").replace(/\s+/g, " ");
  const re = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)\s*(mg|mcg|µg|ug|g|mL|ml|units?|IU)\b/g;
  const matches = [...flat.matchAll(re)];
  const out: SourceMedication[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const before = flat.slice(0, m.index).trimEnd();
    const words = before.split(" ");
    const nameWords: string[] = [];
    for (let j = words.length - 1; j >= 0 && nameWords.length < 3; j--) {
      const w = words[j].replace(/^[(,;:]+|[),;:]+$/g, "");
      if (!w) break;
      if (CONTINUATION.has(w.toLowerCase())) {
        nameWords.unshift(w);
        continue;
      }
      if (NAME_WORD.test(w) && !NOT_A_NAME.has(w)) {
        nameWords.unshift(w);
        break;
      }
      break;
    }
    if (!nameWords.length || !NAME_WORD.test(nameWords[0])) continue;
    const after = flat.slice(m.index! + m[0].length);
    const nextIdx = i + 1 < matches.length ? matches[i + 1].index! - (m.index! + m[0].length) : after.length;
    const sentenceEnd = after.search(/[.;]\s/);
    const restEnd = Math.min(nextIdx, sentenceEnd >= 0 ? sentenceEnd : after.length);
    const rest = after.slice(0, restEnd);
    const name = nameWords.join(" ");
    if (!specificDrugName(name)) continue;
    out.push({ name, dose: m[0], doseTokens: doseTokens(m[0]), frequency: canonicalFrequency(rest), durationDays: durationDays(rest), via: "prose" });
  }
  return out;
}

/** Union of section and prose extraction, de-duplicated by normalised name (section entries win). */
export function extractSourceMedications(text: string): SourceMedication[] {
  const out: SourceMedication[] = [];
  const seen = new Set<string>();
  for (const med of [...extractSectionMedications(text), ...extractProseMedications(text)]) {
    const key = specificDrugName(med.name) ?? normName(med.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(med);
  }
  return out;
}

/* ---------- the check ---------- */

function textAround(med: Medication, output: AiOutput): string {
  const cands = nameCandidates(med.name);
  const steps = output.steps.filter((s) => cands.some((c) => c.length >= 5 && s.text.toLowerCase().includes(c))).map((s) => s.text);
  return [med.dose, med.howOften, med.why, ...steps].join(" ");
}

export function runSafetyChecks(sourceText: string, output: AiOutput, now: () => Date = () => new Date()): SafetyResult {
  const sourceNorm = normalizeDoseText(sourceText);
  const sourceMeds = extractSourceMedications(sourceText);
  const verified: SafetyResult["verified"] = [];
  const dropped: DroppedItem[] = [];
  const unsupported: UnsupportedItem[] = [];

  // Direction 1: nothing the source says may be missing from the output.
  for (const src of sourceMeds) {
    const match = output.medications.find((m) => namesMatch(src.name, m.name));
    if (!match) {
      dropped.push({ name: src.name, missing: ["medication"], expected: { dose: src.dose, frequency: src.frequency, durationDays: src.durationDays } });
      continue;
    }
    const missing: DroppedItem["missing"] = [];
    const around = normalizeDoseText(textAround(match, output));
    for (const tok of src.doseTokens) if (!around.includes(tok)) missing.push("dose");
    const outFreq = canonicalFrequency(match.howOften);
    if (src.frequency && match.status !== "stop" && outFreq !== src.frequency) missing.push("frequency");
    if (src.durationDays !== undefined && match.status !== "stop" && durationDays(`for ${match.howOften}`) !== src.durationDays && durationDays(match.howOften) !== src.durationDays) {
      const re = new RegExp(`\\b${src.durationDays}\\b`);
      if (!re.test(textAround(match, output))) missing.push("duration");
    }
    if (missing.length) {
      dropped.push({ name: src.name, missing: [...new Set(missing)], expected: { dose: src.dose, frequency: src.frequency, durationDays: src.durationDays }, found: { dose: match.dose, frequency: outFreq } });
    } else {
      verified.push({ name: src.name, dose: src.dose, frequency: src.frequency, durationDays: src.durationDays, matchedOutput: match.name });
    }
  }

  // Direction 2: nothing in the output may be absent from the source.
  for (const med of output.medications) {
    if (!nameCandidates(med.name).some((c) => sourceNorm.includes(c))) {
      unsupported.push({ name: med.name, dose: med.dose || undefined, problem: "medication_not_in_source" });
      continue;
    }
    for (const tok of doseTokens(med.dose)) {
      if (!sourceNorm.includes(tok)) unsupported.push({ name: med.name, dose: med.dose, problem: "dose_not_in_source" });
    }
  }

  const grade = output.steps.length ? readabilityGrade(output.steps.map((s) => s.text).join(". ")) : undefined;
  const passed = dropped.length === 0 && unsupported.length === 0;
  return {
    passed,
    checkedAt: now().toISOString(),
    method: "deterministic",
    sourceMedicationCount: sourceMeds.length,
    outputMedicationCount: output.medications.length,
    verified,
    dropped,
    unsupported,
    readabilityGrade: grade,
    reason: passed ? undefined : `safety_check_failed dropped=${dropped.length} unsupported=${unsupported.length}`,
  };
}

/* ---------- translation check (names, doses and numbers verbatim; structure preserved) ---------- */

export interface TranslationCheck {
  language: string;
  passed: boolean;
  issues: string[];
}

const NUM_RE = /\d+(?:[.,]\d+)?/g;
const numbersIn = (s: string) => (s.match(NUM_RE) ?? []).map((n) => n.replace(",", ".")).join(",");

export function checkTranslation(english: AiOutput, translated: AiOutput): TranslationCheck {
  const issues: string[] = [];
  if (translated.medications.length !== english.medications.length) issues.push("medication_count_changed");
  for (let i = 0; i < Math.min(english.medications.length, translated.medications.length); i++) {
    const a = english.medications[i];
    const b = translated.medications[i];
    if (a.name.trim().toLowerCase() !== b.name.trim().toLowerCase()) issues.push(`medication_name_changed:${i}`);
    if (doseTokens(a.dose).join("|") !== doseTokens(b.dose).join("|")) issues.push(`medication_dose_changed:${i}`);
    if (numbersIn(a.howOften) !== numbersIn(b.howOften)) issues.push(`medication_frequency_numbers_changed:${i}`);
    if (a.status !== b.status) issues.push(`medication_status_changed:${i}`);
  }
  if (translated.steps.length !== english.steps.length) issues.push("step_count_changed");
  if (translated.steps.map((s) => s.id).join("|") !== english.steps.map((s) => s.id).join("|")) issues.push("step_ids_changed");
  if (translated.followUps.length !== english.followUps.length) issues.push("followup_count_changed");
  if (translated.warnings.length !== english.warnings.length) issues.push("warning_count_changed");
  if (translated.warnings.map((w) => w.tier ?? "").join("|") !== english.warnings.map((w) => w.tier ?? "").join("|")) issues.push("warning_tiers_changed");
  return { language: translated.language, passed: issues.length === 0, issues };
}
