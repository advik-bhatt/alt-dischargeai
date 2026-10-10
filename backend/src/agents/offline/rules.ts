import type { ChecklistItem, Medication, SimplifiedSummary } from "../types.js";

/**
 * Rule-based simplification for text that matches none of the curated fixtures. No model involved:
 * it reads the headings a discharge summary normally has (diagnoses, new / continue / stopped
 * medications, instructions, return precautions) and fills the structured shape from them. Every
 * drug name and dose is copied from the source line, so the fidelity check passes by construction.
 * Reference for the approach: healthcare-discharge-agent and parsigs (see docs/research.md).
 */

type Section =
  | "none"
  | "diagnoses"
  | "course"
  | "meds_new"
  | "meds_continue"
  | "meds_stop"
  | "instructions"
  | "precautions"
  | "nursing";

const BULLET = /^\s*(?:[•\-*·]|\d+[.)])\s*/;

const GLOSSARY: [RegExp, string][] = [
  [/hfref/i, "weak heart that does not pump well (heart failure)"],
  [/hfpef|diastolic heart failure/i, "stiff heart that holds on to fluid (heart failure)"],
  [/systolic heart failure|heart failure with reduced ef/i, "weak heart that does not pump well (heart failure)"],
  [/heart failure/i, "heart failure (the heart cannot keep up)"],
  [/pneumonia/i, "lung infection (pneumonia)"],
  [/acute kidney injury/i, "kidneys were strained for a short time"],
  [/chronic kidney disease/i, "long-term kidney disease"],
  [/hypertension/i, "high blood pressure"],
  [/diabetes/i, "diabetes (high blood sugar)"],
  [/atrial fibrillation/i, "irregular heartbeat"],
  [/anemia/i, "low red blood cells"],
  [/sepsis/i, "a serious infection that spread to the blood"],
  [/urinary tract infection|pyelonephritis/i, "urinary infection"],
  [/cellulitis/i, "skin infection"],
  [/copd/i, "long-term lung disease (COPD)"],
  [/endocarditis/i, "infection of a heart valve"],
  [/respiratory failure/i, "low oxygen that needed support"],
  [/tobacco use/i, "smoking"],
  [/calculus|stone/i, "kidney stone"],
  [/pulmonary edema/i, "fluid in the lungs"],
];

function plainDiagnosis(clinical: string): string {
  for (const [re, plain] of GLOSSARY) if (re.test(clinical)) return plain;
  return clinical;
}

const DOSE_RE = /(\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?)\s*(mg|mcg|µg|ug|g|ml|mL|units?|iu|%)\b/i;

interface ParsedMed {
  name: string;
  dose: string;
  rest: string;
}

function parseMedLine(line: string): ParsedMed | undefined {
  const text = line.replace(BULLET, "").trim();
  if (!text) return undefined;
  const dash = text.split(/\s[—–-]\s/);
  if (dash.length > 1 && !DOSE_RE.test(dash[0])) {
    return { name: dash[0].trim(), dose: "", rest: dash.slice(1).join(" ").trim() };
  }
  const m = DOSE_RE.exec(text);
  if (m && m.index > 0) {
    const name = text.slice(0, m.index).trim().replace(/[,:]$/, "");
    const dose = `${m[1].replace(/\s+/g, "")} ${m[2]}`;
    const rest = text.slice(m.index + m[0].length).trim().replace(/^[,:]\s*/, "");
    return { name, dose, rest };
  }
  // No dose: the name runs up to the first connective word ("Carvedilol at the discharge dose").
  const firstClause = text.split(/[,:(]/)[0].trim();
  const stop = /\s+\b(as|for|at|by|once|twice|daily|nightly|every|with|while|to|in|if|and|or|after|until|per|that|which|when)\b/i.exec(firstClause);
  const words = (stop ? firstClause.slice(0, stop.index) : firstClause).trim().split(/\s+/);
  const name = words.slice(0, Math.min(words.length, 4)).join(" ").replace(/\.$/, "");
  return { name, dose: "", rest: text.slice(name.length).trim().replace(/^[,:]\s*/, "") };
}

function frequencyFrom(rest: string): string {
  const lower = rest.toLowerCase();
  const byMouth = /by mouth|orally|po\b/.test(lower) ? " by mouth" : /\biv\b|intravenous/.test(lower) ? " through the IV" : "";
  if (/as needed|prn/.test(lower)) return `only when needed${byMouth}`;
  if (/four times (a|per) day|four times daily|qid/.test(lower)) return `four times a day${byMouth}`;
  if (/three times (a|per) day|three times daily|tid/.test(lower)) return `three times a day${byMouth}`;
  if (/twice (a|per) day|twice daily|bid/.test(lower)) return `twice a day${byMouth}`;
  if (/nightly|at bedtime|every night|qhs/.test(lower)) return `every night${byMouth}`;
  if (/every other day/.test(lower)) return `every other day${byMouth}`;
  if (/once (a|per) day|once daily|daily|every day|qd/.test(lower)) return `once a day${byMouth}`;
  if (/as instructed|as reconciled|as directed|as reviewed|as listed|discharge dose/.test(lower))
    return "as on your final medication list";
  return rest ? rest : "as directed";
}

function durationFrom(rest: string): string | undefined {
  const m = /for\s+(\d+)\s+(additional\s+|more\s+)?(day|week|month)s?/i.exec(rest);
  if (!m) return undefined;
  return `for ${m[1]} more ${m[3]}${Number(m[1]) === 1 ? "" : "s"}`;
}

function whyFrom(rest: string, bucket: "new" | "continue"): string {
  const m = /\bfor\s+([^.]+?)(?:\.|$)/i.exec(rest.replace(/for\s+\d+\s+(additional\s+|more\s+)?(day|week|month)s?/i, ""));
  if (m && m[1] && !/^\d/.test(m[1].trim())) return `For ${m[1].trim().toLowerCase()}.`;
  return bucket === "new" ? "A new medicine your care team started." : "Keep taking this medicine as before.";
}

function toMedication(p: ParsedMed, bucket: "new" | "continue"): Medication {
  const freq = frequencyFrom(p.rest);
  const dur = durationFrom(p.rest);
  return {
    name: p.name,
    dose: p.dose,
    howOften: dur ? `${freq} ${dur}` : freq,
    why: whyFrom(p.rest, bucket),
  };
}

function sectionFor(line: string, current: Section): Section {
  const l = line.trim().toLowerCase().replace(/[:\s]+$/, "");
  if (/^nursing/.test(l) || /^what nursing/.test(l)) return "nursing";
  // Headings are short. A wrapped sentence fragment that happens to start with "stopped," is not one.
  if (l.length > 45 || /[,.]$/.test(l)) return current;
  if (/^discharge diagnos/.test(l) || /^diagnoses$/.test(l)) return "diagnoses";
  if (/^hospital course/.test(l)) return "course";
  if (/^(new medications?|new|start)$/.test(l) || /^new medications?/.test(l)) return "meds_new";
  if (/^(continue|continued|continue medications?|unchanged)$/.test(l) || /^continue\b/.test(l)) return "meds_continue";
  if (/^(stopped|stop|held|stopped\/held|discontinued|stopped or held)/.test(l)) return "meds_stop";
  if (/^discharge instructions?/.test(l) || /^instructions?$/.test(l)) return "instructions";
  if (/^return precautions?/.test(l) || /^when to (seek|call|return)/.test(l) || /^warning signs?/.test(l)) return "precautions";
  if (/^discharge medications?/.test(l)) return "none";
  return current;
}

function classifyPrecaution(text: string): "call911" | "goToER" | "callClinic" {
  const l = text.toLowerCase();
  if (/chest pain|faint|syncope|confusion|stroke|facial droop|difficulty speaking|blue|gray lips|severe (shortness of breath|difficulty breathing)|inability to stay awake|severe weakness|difficulty breathing|not relieved/.test(l))
    return "call911";
  if (/fever|chills|bleeding|vomit|swelling|edema|urine|shortness of breath|breathless|pain|oxygen|infection|obstruction|drainage|rigors|heartbeat/.test(l))
    return "goToER";
  return "callClinic";
}

export function ruleBasedSimplify(text: string): SimplifiedSummary {
  const lines = text
    .replace(/-\r?\n\s*/g, "-")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""));

  // Re-join wrapped bullet continuation lines so one bullet is one line.
  const joined: string[] = [];
  for (const line of lines) {
    const isBullet = BULLET.test(line);
    const isHeading = sectionFor(line, "none") !== "none" || /^[A-Z][A-Za-z /-]{2,40}$/.test(line.trim());
    if (!isBullet && !isHeading && joined.length && BULLET.test(joined[joined.length - 1]) && line.trim()) {
      joined[joined.length - 1] += ` ${line.trim()}`;
    } else {
      joined.push(line);
    }
  }

  let section: Section = "none";
  const diagnoses: string[] = [];
  const medsNew: ParsedMed[] = [];
  const medsContinue: ParsedMed[] = [];
  const medsStop: ParsedMed[] = [];
  const instructions: string[] = [];
  const precautions: string[] = [];
  let admissionReason = "";

  for (const raw of joined) {
    const line = raw.trim();
    if (!line) continue;
    const next = sectionFor(line, section);
    if (next !== section || /^(new medications?|continue|stopped|discharge|return|hospital course|nursing)/i.test(line)) {
      section = next;
      if (sectionFor(line, "none") !== "none") continue;
    }
    const adm = /^admission diagnosis:\s*(.+)$/i.exec(line);
    if (adm) {
      admissionReason = adm[1].trim();
      continue;
    }
    if (!BULLET.test(line) && section !== "course") continue;
    const item = line.replace(BULLET, "").trim();
    switch (section) {
      case "diagnoses":
        diagnoses.push(item);
        break;
      case "meds_new": {
        const p = parseMedLine(item);
        if (p) medsNew.push(p);
        break;
      }
      case "meds_continue": {
        const p = parseMedLine(item);
        if (p) medsContinue.push(p);
        break;
      }
      case "meds_stop": {
        const p = parseMedLine(item);
        if (p) medsStop.push(p);
        break;
      }
      case "instructions":
        instructions.push(item);
        break;
      case "precautions":
        precautions.push(item);
        break;
      default:
        break;
    }
  }

  const checklist: ChecklistItem[] = [];
  let medN = 0;
  let apptN = 0;
  let labN = 0;
  let vitalN = 0;
  let lifeN = 0;
  const followUps: SimplifiedSummary["followUps"] = [];

  const newMeds = medsNew.map((p) => toMedication(p, "new"));
  for (const m of newMeds) {
    medN += 1;
    checklist.push({ id: `med-${medN}`, type: "med", text: `Take ${m.name}${m.dose ? ` ${m.dose}` : ""} ${m.howOften}`.trim(), due: "every day" });
  }
  for (const ins of instructions) {
    const l = ins.toLowerCase();
    const fu = /follow[- ]?up with ([^.]+?)(?:\.|$)/i.exec(ins);
    if (fu) {
      let clause = fu[1].trim();
      const whenMatch = /\b(within [^,]+?|as arranged|as scheduled|as directed)\s*$/i.exec(clause) ?? /\b(within [^,]+?)(?=,|\s+for\b)/i.exec(clause);
      const when = whenMatch ? whenMatch[1].trim() : "as arranged";
      if (whenMatch) clause = clause.replace(whenMatch[0], " ").trim();
      const whyMatch = /\bfor (.+)$/i.exec(clause);
      const why = whyMatch ? `For ${whyMatch[1].trim()}` : "Check your recovery and your medicines";
      if (whyMatch) clause = clause.slice(0, whyMatch.index).trim();
      const who = clause.replace(/[,\s]+$/, "");
      for (const part of who.split(/,|\band\b/).map((s) => s.trim()).filter(Boolean)) {
        apptN += 1;
        followUps.push({ who: part, when, why });
        checklist.push({ id: `appt-${apptN}`, type: "appointment", text: `See ${part}`, due: when });
      }
      continue;
    }
    if (/\b(lab|panel|blood test|renal function|kidney function|electrolyte|creatinine|potassium|culture)\b/.test(l)) {
      labN += 1;
      checklist.push({ id: `lab-${labN}`, type: "lab", text: ins, due: "as directed" });
      continue;
    }
    if (/\b(weigh|weight|blood pressure|glucose|blood sugar|temperature|oxygen|monitor)\b/.test(l)) {
      vitalN += 1;
      checklist.push({ id: `vital-${vitalN}`, type: "vital", text: ins, due: "every day" });
      continue;
    }
    if (/\b(diet|sodium|salt|fluid|smok|exercise|activity|elevate|hydration|drink)\b/.test(l)) {
      lifeN += 1;
      checklist.push({ id: `life-${lifeN}`, type: "lifestyle", text: ins, due: "every day" });
      continue;
    }
    if (/\b(antibiotic|complete|finish)\b/.test(l)) {
      medN += 1;
      checklist.push({ id: `med-${medN}`, type: "med", text: ins, due: "until the course is done" });
    }
  }

  const returnPrecautions = { call911: [] as string[], goToER: [] as string[], callClinic: [] as string[] };
  for (const p of precautions) returnPrecautions[classifyPrecaution(p)].push(p);

  const summaryParts: string[] = [];
  summaryParts.push(
    admissionReason
      ? `You were in the hospital for ${plainDiagnosis(admissionReason).toLowerCase()}.`
      : diagnoses.length
        ? `You were in the hospital for ${plainDiagnosis(diagnoses[0]).toLowerCase()}.`
        : "You were in the hospital and are now going home.",
  );
  if (newMeds.length) summaryParts.push(`You are going home with ${newMeds.length} new medicine${newMeds.length === 1 ? "" : "s"}: ${newMeds.map((m) => m.name).join(", ")}.`);
  if (medsStop.length) summaryParts.push(`Stop or hold: ${medsStop.map((m) => m.name).join(", ")}.`);
  if (followUps.length) summaryParts.push(`See ${followUps.map((f) => f.who).join(" and ")} ${followUps[0].when}.`);
  summaryParts.push("Take your medicines exactly as listed and call your care team if you are not sure about anything.");

  return {
    readingLevel: "grade5",
    language: "en",
    summary: summaryParts.slice(0, 5).join(" "),
    diagnoses: diagnoses.map((d) => ({ plain: plainDiagnosis(d), clinical: d })),
    medications: {
      new: newMeds,
      continue: medsContinue.map((p) => toMedication(p, "continue")),
      stop: medsStop.map((p) => ({ name: p.name, why: p.rest ? p.rest.replace(/^because\s+/i, "Because ") : "Your care team stopped or held this medicine." })),
    },
    checklist,
    returnPrecautions,
    followUps,
    questionsToAsk: [
      "Which of my medicines are new, which continue, and which should I stop?",
      "What warning signs mean I should call you, and which mean I should call 911?",
      "When is my next appointment, and what tests do I need before it?",
    ],
  };
}
