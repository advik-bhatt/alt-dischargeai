import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { SimplifiedSummarySchema, type SimplifiedSummary } from "../types.js";

export const FIXTURES_DIR = join(import.meta.dirname, "..", "..", "..", "fixtures");

/**
 * Fingerprints for the five hackathon examples. A source text matches a fixture when enough of its
 * markers appear; ties go to the example whose first marker appears earliest in the text.
 */
export const FIXTURE_MANIFEST: { id: string; file: string; markers: string[] }[] = [
  {
    id: "example-1",
    file: "example-1.json",
    markers: ["acute on chronic hfref", "furosemide 40 mg", "losartan 25 mg", "amoxicillin-clavulanate", "empagliflozin 10 mg", "spironolactone"],
  },
  {
    id: "example-2",
    file: "example-2.json",
    markers: ["ureteral", "cefpodoxime 200 mg", "tamsulosin 0.4 mg", "hydronephrosis", "stent"],
  },
  {
    id: "example-3",
    file: "example-3.json",
    markers: ["hfpef", "torsemide 20 mg", "cephalexin 500 mg", "cellulitis", "metoprolol succinate 75 mg"],
  },
  {
    id: "example-4",
    file: "example-4.json",
    markers: ["copd exacerbation", "prednisone 40 mg", "doxycycline 100 mg", "maintenance inhaler", "albuterol"],
  },
  {
    id: "example-5",
    file: "example-5.json",
    markers: ["endocarditis", "cefazolin", "picc", "mitral", "infectious-disease"],
  },
];

/** Lowercase, collapse whitespace, re-join words hyphenated across line breaks ("lower-\nextremity"). */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .replace(/-\s*\r?\n\s*/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export interface FixtureMatch {
  id: string;
  score: number;
  firstIndex: number;
}

export function matchFixture(text: string, minMarkers = 3): FixtureMatch | undefined {
  const hay = normalizeForMatch(text);
  let best: FixtureMatch | undefined;
  for (const f of FIXTURE_MANIFEST) {
    let score = 0;
    let firstIndex = Number.MAX_SAFE_INTEGER;
    for (const m of f.markers) {
      const idx = hay.indexOf(m);
      if (idx >= 0) {
        score += 1;
        firstIndex = Math.min(firstIndex, idx);
      }
    }
    if (score < minMarkers) continue;
    if (!best || score > best.score || (score === best.score && firstIndex < best.firstIndex)) {
      best = { id: f.id, score, firstIndex };
    }
  }
  return best;
}

const cache = new Map<string, SimplifiedSummary>();

export function loadSimplifiedFixture(id: string): SimplifiedSummary {
  const hit = cache.get(id);
  if (hit) return structuredClone(hit);
  const entry = FIXTURE_MANIFEST.find((f) => f.id === id);
  if (!entry) throw new Error(`unknown fixture ${id}`);
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, "offline", "simplified", entry.file), "utf8"));
  const parsed = SimplifiedSummarySchema.parse(raw);
  cache.set(id, parsed);
  return structuredClone(parsed);
}

export function loadTranslationFixture(id: string, lang: string): SimplifiedSummary | undefined {
  const file = join(FIXTURES_DIR, "offline", "translations", `${id}.${lang}.json`);
  if (!existsSync(file)) return undefined;
  return SimplifiedSummarySchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

export function loadTranscriptFixture(name = "dictation-1"): string {
  const file = join(FIXTURES_DIR, "offline", "transcripts", `${name}.json`);
  const raw = JSON.parse(readFileSync(file, "utf8")) as { text: string };
  return raw.text;
}

export function loadExampleText(name: string): string {
  return readFileSync(join(FIXTURES_DIR, "discharge-summaries", `${name}.txt`), "utf8");
}
