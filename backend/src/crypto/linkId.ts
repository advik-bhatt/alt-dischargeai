import { createHash, randomBytes } from "node:crypto";

/** 128 random bits, base64url: 22 characters, unguessable. */
export function newLinkId(): string {
  return randomBytes(16).toString("base64url");
}

/** The database only ever stores this hash; a dump reveals no usable links. */
export function hashLinkId(linkId: string): string {
  return createHash("sha256").update(linkId, "utf8").digest("hex");
}

const LINK_ID_RE = /^[A-Za-z0-9_-]{22}$/;

export function isLinkIdShaped(value: unknown): value is string {
  return typeof value === "string" && LINK_ID_RE.test(value);
}

/** Short, non-reversible handle for logs. */
export function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
