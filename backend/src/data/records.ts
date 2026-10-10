import type { SealedJson } from "../crypto/envelope.js";

/**
 * Lane 4: the DynamoDB table `discharge_records` (partition key `tokenHash`, TTL attribute
 * `expiresAt` in epoch seconds). The SQLite twin stores the same item shape column for column.
 * Patient text never appears in plaintext: transcript, perLanguage, safety and patientLabel are
 * sealed with the key derived from the link token. Everything else is operational metadata.
 */
export type RecordStatus = "processing" | "ready" | "needs_review" | "failed";
export type InputKind = "text" | "audio" | "text+audio";

export interface PipelineMetaStored {
  provider?: string;
  model?: string;
  speechProvider?: string;
  fixture?: string;
  latencyMs?: number;
  sourceChars?: number;
  skipped?: { language: string; reason: string }[];
  ranAt?: string;
}

export interface DischargeRecord {
  tokenHash: string;
  createdAt: string;
  updatedAt: string;
  /** TTL attribute: epoch seconds, createdAt + 30 days. */
  expiresAt: number;
  status: RecordStatus;
  /** Counts and codes only; never PHI. */
  statusReason?: string;
  /** The language the provider picked. */
  language: string;
  /** Every language the record holds or will hold; English always included. */
  languages: string[];
  inputKind: InputKind;
  /** Object key in the S3 audio bucket (or the local twin), when audio was recorded. */
  audioKey?: string;
  keyVersion: number;
  transcript?: SealedJson;
  perLanguage?: SealedJson;
  safety?: SealedJson;
  patientLabel?: SealedJson;
  pipeline?: PipelineMetaStored;
}

export interface ExpiredRecordRef {
  tokenHash: string;
  expiresAt: number;
  audioKey?: string;
}

export interface RecordStore {
  readonly name: "local" | "dynamo";
  put(record: DischargeRecord): Promise<void>;
  get(tokenHash: string): Promise<DischargeRecord | null>;
  update(tokenHash: string, patch: Partial<Omit<DischargeRecord, "tokenHash">>): Promise<void>;
  /** Returns false when nothing was there. */
  delete(tokenHash: string): Promise<boolean>;
  /** Items whose TTL has passed: what DynamoDB's TTL process would delete; the local sweeper's input. */
  listExpired(nowEpochSeconds: number, limit?: number): Promise<ExpiredRecordRef[]>;
  /** Records still `processing` since before the given moment (a restart lost their in-memory input). */
  listProcessingBefore(iso: string): Promise<string[]>;
  close(): Promise<void>;
}

export const RECORD_FIELDS: (keyof DischargeRecord)[] = [
  "tokenHash",
  "createdAt",
  "updatedAt",
  "expiresAt",
  "status",
  "statusReason",
  "language",
  "languages",
  "inputKind",
  "audioKey",
  "keyVersion",
  "transcript",
  "perLanguage",
  "safety",
  "patientLabel",
  "pipeline",
];
