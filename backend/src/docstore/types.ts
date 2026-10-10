/**
 * The document store holds only ciphertext. The real table is DynamoDB `discharge-summaries` with a
 * single hash key `uid` (string) and TTL on `expiresAt` (epoch seconds). Items for one link share
 * the link hash as a prefix:
 *   uid = <linkIdHash>#raw                 the clinician text
 *   uid = <linkIdHash>#simplified          the LLM response (English fixed JSON + safety result)
 *   uid = <linkIdHash>#translation#<lang>  one per cached translation
 * `pk` (the link hash) and `sk` (raw | simplified | translation#<lang>) are kept as attributes as
 * well, so a per-link listing is a filtered scan and the Streams handler can name what was deleted.
 */
export interface DocItem {
  pk: string;
  sk: string;
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
  keyVersion: number;
  expiresAt: number;
  createdAt: string;
}

export interface DocumentStore {
  readonly name: "local" | "dynamo";
  /** Where the items live, for logs and /health (table name or SQL twin). */
  readonly describe: string;
  put(item: DocItem): Promise<void>;
  get(pk: string, sk: string): Promise<DocItem | null>;
  list(pk: string, skPrefix?: string): Promise<DocItem[]>;
  /** Deletes every item under a link hash. Returns how many were removed. */
  deleteAll(pk: string): Promise<number>;
  /** Items whose TTL has passed, for the purge job's backstop sweep. */
  listExpired(nowEpochSeconds: number, limit?: number): Promise<Pick<DocItem, "pk" | "sk">[]>;
  delete(pk: string, sk: string): Promise<void>;
}

export const SK = {
  raw: "raw",
  simplified: "simplified",
  translation: (lang: string) => `translation#${lang}`,
  translationPrefix: "translation#",
} as const;

/** Partition value from the link hash (never the raw id). */
export function pkFor(linkIdHash: string): string {
  return linkIdHash;
}

/** The hash-key value of one item in `discharge-summaries`. */
export function uidFor(pk: string, sk: string): string {
  return `${pk}#${sk}`;
}

/** Inverse of uidFor: the link hash is the 64-hex prefix, the rest is the sort key. */
export function splitUid(uid: string): { pk: string; sk: string } | undefined {
  const m = /^([0-9a-f]{64})#(.+)$/.exec(uid);
  return m ? { pk: m[1], sk: m[2] } : undefined;
}
