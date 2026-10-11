import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import type { AiOutput } from "../src/contracts/aiOutput.js";
import { newSumId } from "../src/crypto/sumId.js";
import { SqliteDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";
import { DynamoSummaryStore, type DocClient } from "../src/docstore/dynamo.js";
import { LocalSummaryStore } from "../src/docstore/local.js";
import { languagesOf, type SummaryItem } from "../src/docstore/types.js";
import { FIXTURES } from "./helpers.js";

const english = JSON.parse(readFileSync(join(FIXTURES, "offline", "ai-output", "example-1.en.json"), "utf8")) as AiOutput;
const spanish = JSON.parse(readFileSync(join(FIXTURES, "offline", "ai-output", "example-1.es.json"), "utf8")) as AiOutput;

function item(uid: string, expiresAt: number): SummaryItem {
  return { uid, "sum-id": uid, patientID: "pt-0001", "raw-text": "Furosemide 40 mg by mouth once daily.", status: "processing", createdAt: "2026-10-10T00:00:00.000Z", expiresAt, inputKind: "text" };
}

/**
 * An in-memory stand-in for the discharge-summaries table: single hash key, PutItem, GetItem,
 * UpdateItem with SET (top level and the nested translations.<lang> path), DeleteItem with
 * ReturnValues ALL_OLD, filtered scans with paging.
 */
function fakeTable(key = "uid") {
  const rows = new Map<string, Record<string, unknown>>();
  const commands: { name: string; input: Record<string, unknown> }[] = [];
  const client: DocClient = {
    async send(cmd) {
      const input = (cmd as { input: Record<string, unknown> }).input;
      commands.push({ name: cmd.constructor.name, input });
      const keyOf = () => String((input.Key as Record<string, unknown>)[key]);
      if (cmd instanceof PutCommand) {
        const it = input.Item as Record<string, unknown>;
        rows.set(String(it[key]), structuredClone(it));
        return {};
      }
      if (cmd instanceof GetCommand) return { Item: rows.get(keyOf()) };
      if (cmd instanceof UpdateCommand) {
        const row = rows.get(keyOf());
        if (!row) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;
        const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
        // Like DynamoDB: attribute_not_exists(#x) fails the write when the attribute is there.
        const notExists = /attribute_not_exists\((#\w+)\)/.exec(String(input.ConditionExpression ?? ""));
        if (notExists && row[names[notExists[1]]] !== undefined) throw Object.assign(new Error("The conditional request failed"), { name: "ConditionalCheckFailedException" });
        for (const clause of String(input.UpdateExpression).replace(/^SET\s+/, "").split(",")) {
          const [lhs, rhs] = clause.split("=").map((s) => s.trim());
          const path = lhs.split(".").map((p) => names[p] ?? p);
          let target = row;
          // Like DynamoDB: a nested SET needs the parent map to exist already.
          for (const p of path.slice(0, -1)) {
            const next = target[p];
            if (next === undefined || next === null || typeof next !== "object") throw Object.assign(new Error("The document path provided in the update expression is invalid for update"), { name: "ValidationException" });
            target = next as Record<string, unknown>;
          }
          target[path[path.length - 1]] = structuredClone(values[rhs]);
        }
        return {};
      }
      if (cmd instanceof DeleteCommand) {
        const old = rows.get(keyOf());
        rows.delete(keyOf());
        return { Attributes: old };
      }
      if (cmd instanceof ScanCommand) {
        const values = input.ExpressionAttributeValues as Record<string, unknown>;
        const names = input.ExpressionAttributeNames as Record<string, string>;
        const filter = String(input.FilterExpression);
        if (!filter.startsWith("attribute_exists(#s) AND expiresAt <= :now")) throw new Error(`unexpected filter ${filter}`);
        const all = [...rows.values()].filter((r) => r[names["#s"]] !== undefined && Number(r.expiresAt) <= Number(values[":now"]));
        // Page by 2 to prove LastEvaluatedKey handling.
        const start = input.ExclusiveStartKey ? all.findIndex((r) => r[key] === (input.ExclusiveStartKey as Record<string, unknown>)[key]) + 1 : 0;
        const page = all.slice(start, start + 2).map((r) => ({ [key]: r[key], expiresAt: r.expiresAt }));
        const last = start + 2 < all.length ? { [key]: page[page.length - 1][key] } : undefined;
        return { Items: page, LastEvaluatedKey: last };
      }
      throw new Error("unexpected command");
    },
  };
  return { rows, commands, client };
}

describe("summary store: one item per summary in discharge-summaries, uid = sumId", () => {
  it("languagesOf lists English (the llm-summary) first, then the translations", () => {
    expect(languagesOf({ translations: {} })).toEqual([]);
    expect(languagesOf({ "llm-summary": english, translations: {} })).toEqual(["en"]);
    expect(languagesOf({ "llm-summary": english, translations: { es: spanish, zh: spanish } })).toEqual(["en", "es", "zh"]);
  });

  it("DynamoDB store: put, get, update SET of readable attributes, setTranslation on the nested map, delete, listExpired with paging", async () => {
    const table = fakeTable();
    const store = new DynamoSummaryStore({ tableName: "discharge-summaries", keyAttribute: "uid", region: "us-west-2" }, table.client);
    expect(store.describe).toContain("discharge-summaries");
    const a = newSumId();
    const b = newSumId();
    const c = newSumId();
    await store.put(item(a, 1_800_000_000));
    await store.put(item(b, 1_700_000_000));
    await store.put(item(c, 1_700_000_001));
    // receipt items share the table but carry no sum-id, so the backstop sweep never sees them
    table.rows.set(`receipt#${a}#r1`, { uid: `receipt#${a}#r1`, kind: "receipt", at: "2026-10-10T00:00:00.000Z" });

    const putInput = table.commands.find((c) => c.name === "PutCommand")!.input;
    expect(putInput.TableName).toBe("discharge-summaries");
    expect(putInput.Item).toMatchObject({ uid: a, "sum-id": a, patientID: "pt-0001", "raw-text": "Furosemide 40 mg by mouth once daily.", status: "processing", expiresAt: 1_800_000_000 });
    expect(putInput.Item).not.toHaveProperty("translations");

    await store.update(a, { "llm-summary": english, "sum-id": a, status: "ready", meta: { provider: "offline" } });
    const update = table.commands.filter((c) => c.name === "UpdateCommand")[0].input;
    expect(update.UpdateExpression).toBe("SET #a0 = :v0, #a1 = :v1, #a2 = :v2, #a3 = :v3");
    expect(update.ExpressionAttributeNames).toMatchObject({ "#k": "uid", "#a0": "llm-summary", "#a1": "sum-id", "#a2": "status", "#a3": "meta" });
    expect(update.ConditionExpression).toBe("attribute_exists(#k)");
    // The item has no translations map yet, so the first translation creates it (nested SET fails, map is created).
    await store.setTranslation(a, "es", spanish);
    const updates = table.commands.filter((c) => c.name === "UpdateCommand");
    expect(updates[1].input.UpdateExpression).toBe("SET #t.#lang = :v");
    expect(updates[1].input.ExpressionAttributeNames).toEqual({ "#t": "translations", "#lang": "es", "#k": "uid" });
    expect(updates[2].input.UpdateExpression).toBe("SET #t = :m");
    expect(updates[2].input.ConditionExpression).toBe("attribute_exists(#k) AND attribute_not_exists(#t)");
    expect(updates[2].input.ExpressionAttributeValues).toEqual({ ":m": { es: spanish } });

    const got = await store.get(a);
    expect(got).toMatchObject({ uid: a, "sum-id": a, status: "ready" });
    expect(got?.["llm-summary"]?.medications[0].name).toBe("Furosemide");
    expect(Object.keys(got?.translations ?? {})).toEqual(["es"]);
    expect(got?.translations?.es.steps[0].text).toMatch(/^Tome Furosemide 40 mg/);
    expect(table.commands.find((c) => c.name === "GetCommand")!.input.Key).toEqual({ uid: a });
    expect(await store.get(newSumId())).toBeNull();
    await expect(store.update(newSumId(), { status: "failed" })).rejects.toThrow(/conditional/);

    expect(await store.listExpired(1_750_000_000)).toEqual([
      { uid: b, expiresAt: 1_700_000_000 },
      { uid: c, expiresAt: 1_700_000_001 },
    ]);
    expect(table.commands.filter((c) => c.name === "ScanCommand").length).toBeGreaterThanOrEqual(1);
    expect(await store.listExpired(1_750_000_000, 1)).toHaveLength(1);

    expect(await store.delete(b)).toBe(true);
    expect(await store.delete(b)).toBe(false);
    expect(table.rows.has(b)).toBe(false);
    expect(table.rows.has(`receipt#${a}#r1`)).toBe(true);
  });

  it("DynamoDB store: translations are created by the first translation, later ones use the nested SET, concurrent first writes both land, a deleted item errors", async () => {
    const table = fakeTable();
    const store = new DynamoSummaryStore({ tableName: "discharge-summaries", keyAttribute: "uid", region: "us-west-2" }, table.client);
    const a = newSumId();
    await store.put(item(a, 1_800_000_000));
    expect((await store.get(a))?.translations).toBeUndefined();
    await store.setTranslation(a, "es", spanish);
    const before = table.commands.filter((c) => c.name === "UpdateCommand").length;
    await store.setTranslation(a, "zh", spanish);
    expect(table.commands.filter((c) => c.name === "UpdateCommand").length).toBe(before + 1);
    expect(Object.keys((await store.get(a))?.translations ?? {})).toEqual(["es", "zh"]);

    // Two first translations at once, on an item that has none: one creates the map, the other falls back to the nested SET.
    const b = newSumId();
    await store.put(item(b, 1_800_000_000));
    await Promise.all([store.setTranslation(b, "es", spanish), store.setTranslation(b, "ar", spanish)]);
    expect(Object.keys((await store.get(b))?.translations ?? {}).sort()).toEqual(["ar", "es"]);

    // An item that does not exist (purged meanwhile) is an error, never a silent write.
    await expect(store.setTranslation(newSumId(), "es", spanish)).rejects.toThrow(/conditional/);
  });

  it("the SQL twin keeps the same uid and item shape, merges updates and translations, and lists expired items", async () => {
    const db = new SqliteDb(":memory:");
    await migrate(db);
    const store = new LocalSummaryStore(db);
    expect(store.describe).toContain("summaries");
    const a = newSumId();
    const b = newSumId();
    await store.put(item(a, 1_800_000_000));
    await store.put(item(b, 1_700_000_000));
    const row = await db.get<{ uid: string; expires_at: number }>("SELECT uid, expires_at FROM summaries WHERE uid = ?", [a]);
    expect(row).toEqual({ uid: a, expires_at: 1_800_000_000 });

    await store.update(a, { "llm-summary": english, status: "ready" });
    await store.setTranslation(a, "es", spanish);
    await store.setTranslation(a, "zh", spanish);
    const got = await store.get(a);
    expect(got).toMatchObject({ uid: a, "sum-id": a, patientID: "pt-0001", status: "ready" });
    expect(got?.["raw-text"]).toContain("Furosemide 40 mg");
    expect(got?.["llm-summary"]?.medications.map((m) => m.name)).toContain("Furosemide");
    expect(Object.keys(got?.translations ?? {})).toEqual(["es", "zh"]);
    expect(languagesOf(got!)).toEqual(["en", "es", "zh"]);
    await expect(store.update(newSumId(), { status: "failed" })).rejects.toThrow(/does not exist/);

    // Upsert: a second put with the same uid replaces, never duplicates.
    await store.put({ ...item(a, 1_800_000_001), status: "failed" });
    expect((await db.get<{ n: number }>("SELECT COUNT(*) AS n FROM summaries"))?.n).toBe(2);
    expect((await store.get(a))?.status).toBe("failed");
    expect((await store.get(a))?.translations).toBeUndefined();

    expect(await store.listExpired(1_750_000_000)).toEqual([{ uid: b, expiresAt: 1_700_000_000 }]);
    expect(await store.delete(b)).toBe(true);
    expect(await store.delete(b)).toBe(false);
    expect(await store.get(b)).toBeNull();
    await db.close();
  });
});
