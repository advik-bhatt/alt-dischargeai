import type { AiOutput } from "../contracts/aiOutput.js";
import type { Logger } from "../logger.js";
import { ENGLISH, languageName, resolveLanguages } from "./languages.js";
import { checkTranslation, runSafetyChecks } from "./safetyChecks.js";
import type { PipelineResult, Simplifier, SpeechToText, Translator } from "./types.js";

/**
 * Lane 3 composed: (audio -> Speech to text -> transcript) and/or pasted text -> Jargon to plain
 * language -> Safety checks -> verified steps -> Translate -> JSON per language.
 * Person C owns the four modules; this file only wires them in the diagram's order.
 */
export interface PipelineDeps {
  speechToText: SpeechToText;
  simplifier: Simplifier;
  translator: Translator;
  log?: Logger;
  now?: () => Date;
}

export interface PipelineInput {
  /** Pasted EMR text. */
  rawText?: string;
  /** An already-produced transcript (POST /synthesize { token } re-runs from the stored one). */
  transcript?: string;
  /** Audio to transcribe first (POST /ingest with an audio file). */
  audio?: { audio: Buffer; mimeType: string; fileName?: string; audioKey?: string };
  /** BCP-47 codes; English is always produced and comes first. */
  languages: string[];
}

export interface PipelineRun extends PipelineResult {
  /** The clinician text the pipeline actually read (pasted text and/or transcript). */
  sourceText: string;
  transcript?: { text: string; provider: string; jobName?: string; latencyMs?: number };
}

export async function runPipeline(input: PipelineInput, deps: PipelineDeps): Promise<PipelineRun> {
  const t0 = Date.now();
  const now = deps.now ?? (() => new Date());
  const { languages } = resolveLanguages(input.languages[0], input.languages.slice(1));

  // 1. Speech to text.
  let transcript: PipelineRun["transcript"];
  let transcriptText = input.transcript?.trim() ?? "";
  if (!transcriptText && input.audio) {
    const r = await deps.speechToText.transcribe(input.audio);
    transcript = { text: r.transcript, provider: r.provider, jobName: r.jobName, latencyMs: r.latencyMs };
    transcriptText = r.transcript.trim();
  }
  const sourceText = [input.rawText?.trim() ?? "", transcriptText].filter(Boolean).join("\n\n");
  if (!sourceText) throw new Error("empty_input: nothing to simplify");

  // 2. Jargon to plain language (grade 5).
  const simplified = await deps.simplifier.simplify({ text: sourceText });
  const english: AiOutput = { ...simplified.output, language: ENGLISH };

  // 3. Safety checks (never drop meds, doses, times). Failure blocks the record; no translation runs.
  const safety = runSafetyChecks(sourceText, english, now);
  const perLanguage: Record<string, AiOutput> = { [ENGLISH]: english };
  const skipped: PipelineRun["meta"]["skipped"] = [];
  const translations: PipelineRun["safety"]["translations"] = [];

  if (safety.passed) {
    // 4. Translate the verified steps, field by field, one call per language.
    for (const lang of languages) {
      if (lang === ENGLISH) continue;
      try {
        const r = await deps.translator.translate({ english, language: lang, languageName: languageName(lang) });
        const check = checkTranslation(english, { ...r.output, language: lang });
        translations.push(check);
        if (check.passed) {
          perLanguage[lang] = { ...r.output, language: lang };
        } else {
          skipped.push({ language: lang, reason: `translation_check_failed:${check.issues.join(",")}` });
        }
      } catch (err) {
        deps.log?.warn({ language: lang, err: { message: (err as Error).message } }, "translation failed");
        skipped.push({ language: lang, reason: "translation_error" });
      }
    }
  } else {
    for (const lang of languages) if (lang !== ENGLISH) skipped.push({ language: lang, reason: "blocked_by_safety_checks" });
  }

  return {
    perLanguage,
    safety: { ...safety, translations },
    verified: safety.passed,
    sourceText,
    transcript,
    meta: {
      provider: simplified.provider,
      model: simplified.model,
      usage: simplified.usage,
      fixture: simplified.fixture,
      latencyMs: Date.now() - t0,
      sourceChars: sourceText.length,
      skipped,
    },
  };
}
