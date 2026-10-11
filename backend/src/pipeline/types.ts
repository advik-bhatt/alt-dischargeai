import type { AiOutput } from "../contracts/aiOutput.js";
import type { SafetyResult, TranslationCheck } from "./safetyChecks.js";

/** Token usage reported by a model provider, when it reports one. */
export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

/** Lane 3, box 1: Speech to text. Audio in (already stored in the audio bucket), transcript out. */
export interface SpeechToTextInput {
  audio: Buffer;
  mimeType: string;
  fileName?: string;
  /** Key of the same bytes in the audio store; Transcribe Medical reads them from S3 by this key. */
  audioKey?: string;
}

export interface SpeechToTextResult {
  transcript: string;
  provider: string;
  /** Transcribe Medical job name, for traceability. */
  jobName?: string;
  latencyMs?: number;
}

export interface SpeechToText {
  readonly name: string;
  transcribe(input: SpeechToTextInput): Promise<SpeechToTextResult>;
}

/** Lane 3, box 2: Jargon to plain language (grade 5). Raw clinician text in, English contract JSON out. */
export interface SimplifyResult {
  output: AiOutput;
  provider: string;
  model?: string;
  usage?: LlmUsage;
  latencyMs?: number;
  /** Which curated fixture matched, offline provider only. */
  fixture?: string;
}

export interface Simplifier {
  readonly name: string;
  simplify(input: { text: string }): Promise<SimplifyResult>;
}

/** Lane 3, box 4: Translate. English contract JSON in, same structure in the target language out. */
export interface TranslateInput {
  english: AiOutput;
  /** BCP-47 target, e.g. "es", "zh", "ar". */
  language: string;
  /** Display name for the prompt, e.g. "Spanish". */
  languageName: string;
}

export interface TranslateResult {
  output: AiOutput;
  provider: string;
  model?: string;
  usage?: LlmUsage;
  latencyMs?: number;
  fixture?: string;
}

export interface Translator {
  readonly name: string;
  translate(input: TranslateInput): Promise<TranslateResult>;
}

/** What runPipeline returns and what the record stores. */
export interface PipelineSafety extends SafetyResult {
  /** The translation checks, present only when languages were explicitly requested (POST /synthesize). Ingestion translates nothing. */
  translations?: TranslationCheck[];
}

export interface PipelineMeta {
  provider: string;
  model?: string;
  usage?: LlmUsage;
  fixture?: string;
  latencyMs: number;
  sourceChars: number;
  /** Languages that were requested but not produced (blocked record, or a translation that failed its check). */
  skipped: { language: string; reason: string }[];
}

export interface PipelineResult {
  /** Language code -> contract JSON. English is always present. */
  perLanguage: Record<string, AiOutput>;
  safety: PipelineSafety;
  /** False when the safety checks failed: only English is produced and the record must be reviewed. */
  verified: boolean;
  meta: PipelineMeta;
}
