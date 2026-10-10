import { describe, expect, it } from "vitest";
import { aadFor, openFromJson, sealToJson } from "../src/crypto/envelope.js";
import { deriveRecordKey, hashPrefix, hashToken, isTokenShaped, newToken } from "../src/crypto/token.js";

describe("link service crypto", () => {
  it("tokens are 22-char base64url (128 bits) and hash to 64 hex chars, deterministically", () => {
    const t = newToken();
    expect(isTokenShaped(t)).toBe(true);
    expect(hashToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(t)).toBe(hashToken(t));
    expect(newToken()).not.toBe(t);
    expect(hashPrefix(hashToken(t))).toHaveLength(8);
    expect(isTokenShaped("short")).toBe(false);
    expect(isTokenShaped(`${t}!`)).toBe(false);
  });

  it("derives a 32-byte record key from the token that differs from the hash and across key versions", () => {
    const t = newToken();
    const k1 = deriveRecordKey(t, 1);
    expect(k1).toHaveLength(32);
    expect(k1.equals(deriveRecordKey(t, 1))).toBe(true);
    expect(k1.equals(deriveRecordKey(t, 2))).toBe(false);
    expect(k1.toString("hex")).not.toBe(hashToken(t));
    expect(k1.equals(deriveRecordKey(newToken(), 1))).toBe(false);
  });

  it("seals JSON to base64 fields and opens it only with the right key and slot", () => {
    const t = newToken();
    const hash = hashToken(t);
    const key = deriveRecordKey(t, 1);
    const sealed = sealToJson(key, { steps: [{ id: "step-1", text: "Take Furosemide 40 mg" }] }, aadFor(hash, "perLanguage", 1));
    expect(Object.keys(sealed).sort()).toEqual(["ciphertext", "iv", "tag"]);
    expect(JSON.stringify(sealed)).not.toContain("Furosemide");
    expect(openFromJson(key, sealed, aadFor(hash, "perLanguage", 1))).toEqual({ steps: [{ id: "step-1", text: "Take Furosemide 40 mg" }] });
    expect(() => openFromJson(deriveRecordKey(newToken(), 1), sealed, aadFor(hash, "perLanguage", 1))).toThrow();
    expect(() => openFromJson(key, sealed, aadFor(hash, "transcript", 1))).toThrow();
    expect(() => openFromJson(key, sealed, aadFor(hash, "perLanguage", 2))).toThrow();
  });
});
