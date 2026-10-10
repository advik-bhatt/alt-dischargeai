import { describe, expect, it } from "vitest";
import { aadFor, newDataKey, open, openJson, seal, sealJson } from "../src/crypto/envelope.js";
import { hashLinkId, isLinkIdShaped, newLinkId } from "../src/crypto/linkId.js";

describe("crypto", () => {
  it("link ids are 22-char base64url and hash to 64 hex chars", () => {
    const id = newLinkId();
    expect(isLinkIdShaped(id)).toBe(true);
    expect(hashLinkId(id)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLinkId(id)).toBe(hashLinkId(id));
    expect(newLinkId()).not.toBe(id);
  });

  it("round-trips JSON under AES-256-GCM", () => {
    const key = newDataKey();
    const aad = aadFor("link#abc", "simplified", 1);
    const sealed = sealJson(key, { hello: "world", n: 1 }, aad);
    expect(sealed.iv).toHaveLength(12);
    expect(sealed.tag).toHaveLength(16);
    expect(openJson(key, sealed, aad)).toEqual({ hello: "world", n: 1 });
  });

  it("is unreadable after the key is destroyed (any other key fails)", () => {
    const key = newDataKey();
    const aad = aadFor("link#abc", "raw", 1);
    const sealed = seal(key, Buffer.from("Furosemide 40 mg"), aad);
    const otherKey = newDataKey();
    expect(() => open(otherKey, sealed, aad)).toThrow();
    expect(() => open(Buffer.alloc(32), sealed, aad)).toThrow();
  });

  it("rejects a ciphertext moved to another slot (wrong AAD) or tampered", () => {
    const key = newDataKey();
    const sealed = seal(key, Buffer.from("payload"), aadFor("link#abc", "raw", 1));
    expect(() => open(key, sealed, aadFor("link#abc", "simplified", 1))).toThrow();
    expect(() => open(key, sealed, aadFor("link#abc", "raw", 2))).toThrow();
    const tampered = { ...sealed, ciphertext: Buffer.from(sealed.ciphertext) };
    tampered.ciphertext[0] ^= 0xff;
    expect(() => open(key, tampered, aadFor("link#abc", "raw", 1))).toThrow();
  });
});
