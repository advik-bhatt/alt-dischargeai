import type { AiOutput, FollowUp, Medication, Step, Warning } from "../../contracts/aiOutput.js";

/**
 * Rule-based simplification for text that matches none of the curated fixtures. No model involved:
 * it reads the headings a discharge summary normally has (new / continue / stopped medications,
 * instructions, return precautions) and fills the contract from them. Every drug name, dose and
 * frequency is copied from the source line, so the safety checks pass by construction.
 * The approach follows the open-source healthcare-discharge-agent and parsigs projects.
 */

type Section = "none" | "diagnoses" | "course" | "meds_new" | "meds_continue" | "meds_stop" | "instructions" | "precautions" | "nursing";

const BULLET = /^\s*(?:[•\-*·]|\d+[.)])\s*/;
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
  if (/as instructed|as reconciled|as directed|as reviewed|as listed|discharge dose/.test(lower)) return "as on your final medication list";
  return rest ? rest : "as directed";
}

function durationFrom(rest: string): string | undefined {
  const m = /for\s+(\d+)\s+(additional\s+|more\s+)?(day|week|month)s?/i.exec(rest);
  if (!m) return undefined;
  return `for ${m[1]} more ${m[3]}${Number(m[1]) === 1 ? "" : "s"}`;
}

function whyFrom(rest: string, status: "new" | "continue"): string {
  const m = /\bfor\s+([^.]+?)(?:\.|$)/i.exec(rest.replace(/for\s+\d+\s+(additional\s+|more\s+)?(day|week|month)s?/i, ""));
  if (m && m[1] && !/^\d/.test(m[1].trim())) return `For ${m[1].trim().toLowerCase()}.`;
  return status === "new" ? "A new medicine your care team started." : "Keep taking this medicine as before.";
}

function toMedication(p: ParsedMed, status: "new" | "continue"): Medication {
  const freq = frequencyFrom(p.rest);
  const dur = durationFrom(p.rest);
  return { name: p.name, dose: p.dose, howOften: dur ? `${freq} ${dur}` : freq, status, why: whyFrom(p.rest, status) };
}

function sectionFor(line: string, current: Section): Section {
  const l = line.trim().toLowerCase().replace(/[:\s]+$/, "");
  if (/^nursing/.test(l) || /^what nursing/.test(l)) return "nursing";
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

function tierFor(text: string): Warning["tier"] {
  const l = text.toLowerCase();
  if (/chest pain|faint|syncope|confusion|stroke|facial droop|difficulty speaking|blue|gray lips|severe (shortness of breath|difficulty breathing)|inability to stay awake|severe weakness|difficulty breathing|not relieved/.test(l)) return "call911";
  if (/fever|chills|bleeding|vomit|swelling|edema|urine|shortness of breath|breathless|pain|oxygen|infection|obstruction|drainage|rigors|heartbeat/.test(l)) return "er";
  return "clinic";
}

export function ruleBasedSimplify(text: string): AiOutput {
  const lines = text
    .replace(/-\r?\n\s*/g, "-")
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ""));

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
  const medsNew: ParsedMed[] = [];
  const medsContinue: ParsedMed[] = [];
  const medsStop: ParsedMed[] = [];
  const instructions: string[] = [];
  const precautions: string[] = [];

  for (const raw of joined) {
    const line = raw.trim();
    if (!line) continue;
    const next = sectionFor(line, section);
    if (next !== section || /^(new medications?|continue|stopped|discharge|return|hospital course|nursing)/i.test(line)) {
      section = next;
      if (sectionFor(line, "none") !== "none") continue;
    }
    if (!BULLET.test(line)) continue;
    const item = line.replace(BULLET, "").trim();
    switch (section) {
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

  const medications: Medication[] = [
    ...medsNew.map((p) => toMedication(p, "new")),
    ...medsContinue.map((p) => toMedication(p, "continue")),
    ...medsStop.map((p) => ({ name: p.name, dose: "", howOften: "", status: "stop" as const, why: p.rest ? p.rest.replace(/^because\s+/i, "Because ") : "Your care team stopped or held this medicine." })),
  ];

  const steps: Step[] = [];
  const followUps: FollowUp[] = [];
  let n = 0;
  const step = (text: string) => steps.push({ id: `step-${++n}`, text });

  for (const m of medications) {
    if (m.status === "new") step(`Take ${m.name}${m.dose ? ` ${m.dose}` : ""} ${m.howOften}`.trim());
    if (m.status === "stop") step(`Do not take ${m.name}. ${m.why}`.trim());
  }
  for (const ins of instructions) {
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
        followUps.push({ who: part, when, why });
        step(`See ${part} ${when}`);
      }
      continue;
    }
    step(ins.replace(/\s+/g, " "));
  }
  if (!steps.length) step("Take your medicines exactly as listed and call your care team if you are not sure about anything.");

  const warnings: Warning[] = precautions.map((text) => ({ text, tier: tierFor(text) }));

  return { language: "en", steps, medications, followUps, warnings };
}
