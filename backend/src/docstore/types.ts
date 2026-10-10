import type { AiOutput } from "../contracts/aiOutput.js";
import type { LlmUsage, PipelineSafety } from "../pipeline/types.js";

/**
 * The team contract's DynamoDB layout: ONE item per summary in `discharge-summaries`, hash key
 * `uid` = the sumId (the random link path), with the attributes teammates read and write directly:
 *   sum-id        the same value as uid
 *   patientID     the patient the summary belongs to
 *   raw-text      the clinician text (pasted, extracted from the PDF, or the transcript)
 *   llm-summary   the LLM's plain-language JSON (the fixed AiOutput in English)
 *   translations  map keyed by language code, each the translated AiOutput
 *   language      the language the provider picked at ingest
 *   status        processing | ready | needs_review | failed
 *   createdAt     ISO-8601
 *   expiresAt     epoch seconds, the table's TTL attribute (createdAt + 30 days)
 * Nothing is encrypted at the application layer: DynamoDB encrypts at rest and the teammates' LLM
 * agent writes `llm-summary` into this same item. The remaining attributes are the backend's own
 * metadata (input kind, object keys in the buckets, the safety-check result, provider and usage).
 */
export type InputKind = "text" | "pdf" | "audio";
export type SummaryStatus = "processing" | "ready" | "needs_review" | "failed";

export interface SummaryMeta {
  provider?: string;
  model?: string;
  usage?: LlmUsage;
  fixture?: string;
  latencyMs?: number;
  sourceChars?: number;
  pdfPages?: number;
  pdfEngine?: string;
  transcript?: { provider: string; jobName?: string; latencyMs?: number };
  skipped?: { language: string; reason: string }[];
}

export interface SummaryItem {
  uid: string;
  "sum-id": string;
  patientID: string;
  "raw-text"?: string;
  "llm-summary"?: AiOutput;
  translations: Record<string, AiOutput>;
  language: string;
  status: SummaryStatus;
  createdAt: string;
  expiresAt: number;
  inputKind: InputKind;
  pdfKey?: string;
  audioKey?: string;
  safety?: PipelineSafety;
  meta?: SummaryMeta;
}

/** Top-level attributes a caller may set after creation (the LLM response, status, translations, metadata). */
export type SummaryPatch = Partial<Omit<SummaryItem, "uid" | "createdAt" | "patientID">>;

export interface SummaryStore {
  readonly name: "local" | "dynamo";
  /** Where the items live, for logs and /health (table name or SQL twin). */
  readonly describe: string;
  put(item: SummaryItem): Promise<void>;
  get(uid: string): Promise<SummaryItem | null>;
  /** Sets the given top-level attributes on an existing item (DynamoDB UpdateItem SET). */
  update(uid: string, patch: SummaryPatch): Promise<void>;
  /** Sets translations[lang] on an existing item without touching the other languages. */
  setTranslation(uid: string, lang: string, output: AiOutput): Promise<void>;
  /** Deletes the item. Returns false when nothing was there. */
  delete(uid: string): Promise<boolean>;
  /** Items whose TTL has passed, for the purge job's backstop sweep. */
  listExpired(nowEpochSeconds: number, limit?: number): Promise<{ uid: string; expiresAt: number }[]>;
}

/** The languages an item holds: English (the LLM response) first, then the translations in insertion order. */
export function languagesOf(item: Pick<SummaryItem, "llm-summary" | "translations">): string[] {
  const out = item["llm-summary"] ? ["en"] : [];
  for (const lang of Object.keys(item.translations ?? {})) if (!out.includes(lang)) out.push(lang);
  return out;
}
