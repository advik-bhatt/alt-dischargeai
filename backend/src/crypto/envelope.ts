import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const KEY_BYTES = 32;
export const IV_BYTES = 12;
export const TAG_BYTES = 16;

export interface Sealed {
  ciphertext: Buffer;
  iv: Buffer;
  tag: Buffer;
}

/** A fresh per-link AES-256 data key. Destroying it makes every payload sealed with it unreadable. */
export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** Additional authenticated data binds a ciphertext to its exact storage slot and key version. */
export function aadFor(pk: string, sk: string, keyVersion: number): Buffer {
  return Buffer.from(`${pk}|${sk}|${keyVersion}`, "utf8");
}

export function seal(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  if (key.length !== KEY_BYTES) throw new Error("data key must be 32 bytes");
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

/** Throws on a wrong key, a tampered ciphertext, a wrong tag or a wrong AAD. */
export function open(key: Buffer, sealed: Sealed, aad: Buffer): Buffer {
  if (key.length !== KEY_BYTES) throw new Error("data key must be 32 bytes");
  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAAD(aad);
  decipher.setAuthTag(sealed.tag);
  return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
}

export function sealJson(key: Buffer, value: unknown, aad: Buffer): Sealed {
  return seal(key, Buffer.from(JSON.stringify(value), "utf8"), aad);
}

export function openJson<T = unknown>(key: Buffer, sealed: Sealed, aad: Buffer): T {
  return JSON.parse(open(key, sealed, aad).toString("utf8")) as T;
}

/** The storable form of a sealed payload: base64 strings, the same in SQLite and DynamoDB. */
export interface SealedJson {
  ciphertext: string;
  iv: string;
  tag: string;
}

export function sealToJson(key: Buffer, value: unknown, aad: Buffer): SealedJson {
  const s = sealJson(key, value, aad);
  return { ciphertext: s.ciphertext.toString("base64"), iv: s.iv.toString("base64"), tag: s.tag.toString("base64") };
}

export function openFromJson<T = unknown>(key: Buffer, sealed: SealedJson, aad: Buffer): T {
  return openJson<T>(key, { ciphertext: Buffer.from(sealed.ciphertext, "base64"), iv: Buffer.from(sealed.iv, "base64"), tag: Buffer.from(sealed.tag, "base64") }, aad);
}
