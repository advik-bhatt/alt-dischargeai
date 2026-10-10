import { createHash, hkdfSync, randomBytes } from "node:crypto";
import { KEY_BYTES } from "./envelope.js";

/**
 * Link service: unguessable token URLs. The token is 128 random bits (22 base64url characters). The
 * store only ever holds `sha256("dischargeai-token" || token)`; a database dump reveals no usable
 * link. The per-record data key is derived from the token with HKDF and stored nowhere, so the
 * encrypted transcript and JSON on a record can only be opened by a caller who presents the link.
 */

const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
const HASH_DOMAIN = "dischargeai-token";
const KEY_SALT = "dischargeai-record-key";

export function newToken(): string {
  return randomBytes(16).toString("base64url");
}

export function isTokenShaped(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** Partition key of the record: hex sha256 with a domain prefix (never the raw token). */
export function hashToken(token: string): string {
  return createHash("sha256").update(HASH_DOMAIN).update(token, "utf8").digest("hex");
}

/** AES-256 data key for one record. Different derivation from the hash, so the hash leaks nothing about the key. */
export function deriveRecordKey(token: string, keyVersion: number): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(token, "utf8"), KEY_SALT, `v${keyVersion}`, KEY_BYTES));
}

/** Short, non-reversible handle for logs. */
export function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
