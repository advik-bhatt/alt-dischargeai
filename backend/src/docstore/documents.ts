import type { AiOutput } from "../contracts/aiOutput.js";
import type { TranslationCheck } from "../pipeline/safetyChecks.js";
import type { LlmUsage, PipelineSafety } from "../pipeline/types.js";

/**
 * What the document store holds for one link, per the note: "DynamoDB holds raw text, LLM response
 * and translations". Every item is sealed with the link's data key before it is written.
 *   <linkIdHash>#raw                 RawDocument
 *   <linkIdHash>#simplified          StoredSummary   (the LLM response: the English fixed JSON + safety result)
 *   <linkIdHash>#translation#<lang>  StoredTranslation
 */
export type InputKind = "text" | "pdf" | "audio";

export interface RawDocument {
  /** The clinician text the pipeline read (pasted text, extracted PDF text or the transcript). */
  text: string;
  kind: InputKind;
  /** The raw link id, kept only here (encrypted) so a resumed job can still build the patient URL. */
  linkId: string;
  /** Object key of the audio clip in the audio store, when the input was audio. */
  audioKey?: string;
  transcript?: { provider: string; jobName?: string; latencyMs?: number };
}

export interface StoredSummary {
  /** The fixed JSON in English, exactly the contract's five keys. */
  output: AiOutput;
  safety: PipelineSafety;
  verified: boolean;
  provider: string;
  model?: string;
  usage?: LlmUsage;
  fixture?: string;
  latencyMs?: number;
  sourceChars: number;
  inputKind: InputKind;
  createdAt: string;
}

export interface StoredTranslation {
  /** The fixed JSON in the target language. */
  output: AiOutput;
  check: TranslationCheck;
  provider: string;
  model?: string;
  usage?: LlmUsage;
  fixture?: string;
  latencyMs?: number;
  createdAt: string;
}
