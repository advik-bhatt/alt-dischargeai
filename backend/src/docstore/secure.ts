import { aadFor, openJson, sealJson } from "../crypto/envelope.js";
import type { DocumentStore } from "./types.js";
import { pkFor } from "./types.js";

/**
 * Encrypt-then-store and fetch-then-decrypt around the document store. Every payload is sealed with
 * the link's data key and bound (AAD) to its pk, sk and key version. Items are addressed by the link
 * hash, never the raw id, so the purge job can find them from the SQL row alone.
 */
export class SecureDocs {
  constructor(private readonly store: DocumentStore) {}

  async putJson(input: {
    linkIdHash: string;
    sk: string;
    key: Buffer;
    keyVersion: number;
    value: unknown;
    expiresAtEpochSeconds: number;
    createdAt: string;
  }): Promise<void> {
    const pk = pkFor(input.linkIdHash);
    const sealed = sealJson(input.key, input.value, aadFor(pk, input.sk, input.keyVersion));
    await this.store.put({
      pk,
      sk: input.sk,
      ciphertext: sealed.ciphertext,
      iv: sealed.iv,
      tag: sealed.tag,
      keyVersion: input.keyVersion,
      expiresAt: input.expiresAtEpochSeconds,
      createdAt: input.createdAt,
    });
  }

  /** Returns null when the item is absent. Throws when the key is wrong or gone. */
  async getJson<T>(input: { linkIdHash: string; sk: string; key: Buffer }): Promise<T | null> {
    const pk = pkFor(input.linkIdHash);
    const item = await this.store.get(pk, input.sk);
    if (!item) return null;
    return openJson<T>(input.key, item, aadFor(pk, input.sk, item.keyVersion));
  }

  async has(linkIdHash: string, sk: string): Promise<boolean> {
    return (await this.store.get(pkFor(linkIdHash), sk)) !== null;
  }

  async deleteAll(linkIdHash: string): Promise<number> {
    return this.store.deleteAll(pkFor(linkIdHash));
  }

  async count(linkIdHash: string): Promise<number> {
    return (await this.store.list(pkFor(linkIdHash))).length;
  }

  async listKeys(linkIdHash: string): Promise<string[]> {
    return (await this.store.list(pkFor(linkIdHash))).map((i) => i.sk);
  }
}
