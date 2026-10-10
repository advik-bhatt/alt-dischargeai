import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { SqliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DynamoDocumentStore, type DocClient } from "../src/docstore/dynamo.js";
import { LocalDocumentStore } from "../src/docstore/local.js";
import { SecureDocs } from "../src/docstore/secure.js";
import { SK, pkFor, splitUid, uidFor, type DocItem } from "../src/docstore/types.js";
import { newDataKey } from "../src/crypto/envelope.js";
import { hashLinkId, newLinkId } from "../src/crypto/linkId.js";

function item(pk: string, sk: string, expiresAt: number): DocItem {
  return { pk, sk, ciphertext: Buffer.from(`c:${sk}`), iv: Buffer.alloc(12, 1), tag: Buffer.alloc(16, 2), keyVersion: 1, expiresAt, createdAt: "2026-10-10T00:00:00.000Z" };
}

/** An in-memory stand-in for the discharge-summaries table: single hash key, filtered scans with paging. */
function fakeTable(key = "uid") {
  const rows = new Map<string, Record<string, unknown>>();
  const commands: { name: string; input: Record<string, unknown> }[] = [];
  const client: DocClient = {
    async send(cmd) {
      const input = (cmd as { input: Record<string, unknown> }).input;
      commands.push({ name: cmd.constructor.name, input });
      if (cmd instanceof PutCommand) {
        const it = input.Item as Record<string, unknown>;
        rows.set(String(it[key]), it);
        return {};
      }
      if (cmd instanceof GetCommand) return { Item: rows.get(String((input.Key as Record<string, unknown>)[key])) };
      if (cmd instanceof DeleteCommand) {
        rows.delete(String((input.Key as Record<string, unknown>)[key]));
        return {};
      }
      if (cmd instanceof ScanCommand) {
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const filter = String(input.FilterExpression);
        const all = [...rows.values()].filter((r) => {
          if (filter.startsWith("pk = :pk")) {
            if (r.pk !== values[":pk"]) return false;
            if (filter.includes("begins_with") && !String(r.sk).startsWith(String(values[":p"]))) return false;
            return true;
          }
          if (filter.startsWith("expiresAt <= :now")) return Number(r.expiresAt) <= Number(values[":now"]);
          throw new Error(`unexpected filter ${filter}`);
        });
        // Page by 2 to prove LastEvaluatedKey handling.
        const start = input.ExclusiveStartKey ? all.findIndex((r) => r[key] === (input.ExclusiveStartKey as Record<string, unknown>)[key]) + 1 : 0;
        const page = all.slice(start, start + 2);
        const last = start + 2 < all.length ? { [key]: page[page.length - 1][key] } : undefined;
        return { Items: page, LastEvaluatedKey: last };
      }
      throw new Error("unexpected command");
    },
  };
  return { rows, commands, client };
}

describe("document store: discharge-summaries with a single hash key uid", () => {
  const hash = hashLinkId(newLinkId());

  it("composes and splits uids", () => {
    expect(pkFor(hash)).toBe(hash);
    expect(uidFor(hash, SK.raw)).toBe(`${hash}#raw`);
    expect(uidFor(hash, SK.translation("es"))).toBe(`${hash}#translation#es`);
    expect(splitUid(`${hash}#translation#zh-Hant`)).toEqual({ pk: hash, sk: "translation#zh-Hant" });
    expect(splitUid("nope")).toBeUndefined();
  });

  it("DynamoDB store: keys every item by uid, keeps pk/sk/expiresAt as attributes, lists by filtered scan with paging, deletes per link", async () => {
    const table = fakeTable();
    const store = new DynamoDocumentStore({ tableName: "discharge-summaries", keyAttribute: "uid", region: "us-west-2" }, table.client);
    expect(store.describe).toContain("discharge-summaries");
    const other = hashLinkId(newLinkId());
    for (const sk of [SK.raw, SK.simplified, SK.translation("es"), SK.translation("zh")]) await store.put(item(hash, sk, 1_800_000_000));
    await store.put(item(other, SK.raw, 1_700_000_000));

    const putInput = table.commands.find((c) => c.name === "PutCommand")!.input;
    expect((putInput.Item as Record<string, unknown>).uid).toBe(`${hash}#raw`);
    expect(putInput.Item).toMatchObject({ pk: hash, sk: "raw", expiresAt: 1_800_000_000, keyVersion: 1 });
    expect(putInput.TableName).toBe("discharge-summaries");

    const got = await store.get(hash, SK.simplified);
    expect(got?.ciphertext.toString()).toBe("c:simplified");
    expect(table.commands.find((c) => c.name === "GetCommand")!.input.Key).toEqual({ uid: `${hash}#simplified` });
    expect(await store.get(hash, SK.translation("fr"))).toBeNull();

    expect((await store.list(hash)).map((i) => i.sk)).toEqual(["raw", "simplified", "translation#es", "translation#zh"]);
    expect((await store.list(hash, SK.translationPrefix)).map((i) => i.sk)).toEqual(["translation#es", "translation#zh"]);
    expect(await store.listExpired(1_750_000_000)).toEqual([{ pk: other, sk: "raw" }]);

    expect(await store.deleteAll(hash)).toBe(4);
    expect(await store.list(hash)).toEqual([]);
    expect(table.rows.size).toBe(1);
    expect(table.commands.filter((c) => c.name === "DeleteCommand").map((c) => (c.input.Key as Record<string, string>).uid)).toEqual([`${hash}#raw`, `${hash}#simplified`, `${hash}#translation#es`, `${hash}#translation#zh`]);
  });

  it("the SQL twin stores the same uid and round-trips sealed JSON through SecureDocs", async () => {
    const db = new SqliteDb(":memory:");
    await migrate(db);
    const store = new LocalDocumentStore(db);
    const docs = new SecureDocs(store);
    const key = newDataKey();
    await docs.putJson({ linkIdHash: hash, sk: SK.simplified, key, keyVersion: 1, value: { output: { steps: [{ id: "step-1", text: "Take Furosemide 40 mg" }] } }, expiresAtEpochSeconds: 1_800_000_000, createdAt: "2026-10-10T00:00:00.000Z" });
    await docs.putJson({ linkIdHash: hash, sk: SK.translation("es"), key, keyVersion: 1, value: { ok: true }, expiresAtEpochSeconds: 1_800_000_000, createdAt: "2026-10-10T00:00:00.000Z" });
    const row = await db.get<{ uid: string; pk: string; sk: string }>("SELECT uid, pk, sk FROM documents WHERE sk = 'simplified'");
    expect(row).toEqual({ uid: `${hash}#simplified`, pk: hash, sk: "simplified" });
    const raw = await db.all<{ ciphertext: Buffer }>("SELECT ciphertext FROM documents");
    expect(raw.every((r) => !Buffer.from(r.ciphertext).toString("utf8").includes("Furosemide"))).toBe(true);
    expect(await docs.getJson(({ linkIdHash: hash, sk: SK.simplified, key }))).toEqual({ output: { steps: [{ id: "step-1", text: "Take Furosemide 40 mg" }] } });
    expect(await docs.listKeys(hash)).toEqual(["simplified", "translation#es"]);
    // Upsert: a second put with the same uid replaces, never duplicates.
    await docs.putJson({ linkIdHash: hash, sk: SK.simplified, key, keyVersion: 1, value: { v: 2 }, expiresAtEpochSeconds: 1_800_000_001, createdAt: "2026-10-11T00:00:00.000Z" });
    expect(await docs.count(hash)).toBe(2);
    expect(await docs.getJson(({ linkIdHash: hash, sk: SK.simplified, key }))).toEqual({ v: 2 });
    expect(await store.listExpired(1_800_000_000)).toEqual([{ pk: hash, sk: "translation#es" }]);
    expect(await docs.deleteAll(hash)).toBe(2);
    await db.close();
  });
});
