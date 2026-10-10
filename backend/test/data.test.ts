import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileAuditSink, newReceipt } from "../src/audit/receipts.js";
import { receiptsFromS3Event, handler as s3Handler } from "../src/audit/s3EventHandler.js";
import { handler as streamHandler, isTtlDeletion, receiptsFromStreamEvent } from "../src/audit/streamHandler.js";
import { newSumId } from "../src/crypto/sumId.js";
import { LocalObjectStore, audioKeyFor, objectKindFor, pdfKeyFor, resolveObjectStore } from "../src/data/objects.js";
import { S3ObjectStore, type S3Like } from "../src/data/s3/objects.js";
import { findTtlRule, mergeTtlRule, RULE_ID } from "../scripts/ensure-s3-lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;

/** An in-memory bucket that answers like S3 (404 NotFound on missing heads). */
function fakeBucket() {
  const objects = new Map<string, { body: Buffer; contentType?: string; sse?: string }>();
  const calls: string[] = [];
  const client: S3Like = {
    async send(cmd: { constructor: { name: string } }) {
      calls.push(cmd.constructor.name);
      const input = (cmd as unknown as { input: Record<string, unknown> }).input;
      if (cmd instanceof HeadBucketCommand) return {};
      if (cmd instanceof PutObjectCommand) {
        objects.set(String(input.Key), { body: Buffer.from(input.Body as Buffer), contentType: input.ContentType as string | undefined, sse: input.ServerSideEncryption as string | undefined });
        return {};
      }
      const found = objects.get(String(input.Key));
      if (cmd instanceof HeadObjectCommand || cmd instanceof GetObjectCommand) {
        if (!found) throw Object.assign(new Error("NotFound"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        if (cmd instanceof HeadObjectCommand) return {};
        return { Body: { transformToByteArray: async () => new Uint8Array(found.body) }, ContentType: found.contentType };
      }
      if (cmd instanceof DeleteObjectCommand) {
        objects.delete(String(input.Key));
        return {};
      }
      throw new Error("unexpected command");
    },
  };
  return { objects, calls, client };
}

describe("the PDF and audio object stores, the lifecycle rule and the deletion receipt handlers", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dischargeai-data-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("object keys are the sumId plus an extension; the kind follows the extension", () => {
    const sumId = newSumId();
    expect(pdfKeyFor(sumId)).toBe(`${sumId}.pdf`);
    expect(audioKeyFor(sumId, "audio/wav", "clip.wav")).toBe(`${sumId}.wav`);
    expect(audioKeyFor(sumId, "application/octet-stream", "voice.webm")).toBe(`${sumId}.webm`);
    expect(audioKeyFor(sumId, "application/octet-stream")).toBe(`${sumId}.bin`);
    expect(objectKindFor(`${sumId}.pdf`)).toBe("pdf");
    expect(objectKindFor(`${sumId}.mp3`)).toBe("audio");
    expect(objectKindFor("transcripts/x.json")).toBeUndefined();
    expect(resolveObjectStore("auto", true)).toBe("s3");
    expect(resolveObjectStore("auto", false)).toBe("local");
    expect(resolveObjectStore("local", true)).toBe("local");
  });

  it("local twin of a bucket: put/get/delete, lifecycle listing by write time, no path escapes", async () => {
    const store = new LocalObjectStore(join(dir, "pdf"));
    const sumId = newSumId();
    const key = pdfKeyFor(sumId);
    await store.put({ key, body: Buffer.from("%PDF-1.4 fake"), contentType: "application/pdf" });
    expect((await store.get(key))?.body.toString()).toBe("%PDF-1.4 fake");
    expect((await store.get(key))?.contentType).toBe("application/pdf");
    expect(await store.listExpired(new Date())).toEqual([]);
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * DAY);
    utimesSync(join(dir, "pdf", key), thirtyOneDaysAgo, thirtyOneDaysAgo);
    expect(await store.listExpired(new Date())).toEqual([{ key, createdAt: expect.any(String) }]);
    expect(await store.delete(key)).toBe(true);
    expect(await store.delete(key)).toBe(false);
    expect(await store.get(key)).toBeNull();
    await expect(store.get("../etc/passwd")).rejects.toThrow("invalid object key");
    expect(store.describe()).toBe(`local:${join(dir, "pdf")}`);
  });

  it("S3 store: writes with SSE-S3 (AES256), reads back, delete reports whether anything was there", async () => {
    const bucket = fakeBucket();
    const store = new S3ObjectStore({ bucket: "emrpdf-rh", region: "us-west-2", client: bucket.client });
    await store.headBucket();
    const sumId = newSumId();
    const key = pdfKeyFor(sumId);
    await store.put({ key, body: Buffer.from("%PDF-1.4 bytes"), contentType: "application/pdf" });
    expect(bucket.objects.get(key)).toMatchObject({ contentType: "application/pdf", sse: "AES256" });
    expect((await store.get(key))?.body.toString()).toBe("%PDF-1.4 bytes");
    expect(await store.get(`${sumId}.mp3`)).toBeNull();
    expect(await store.delete(key)).toBe(true);
    expect(await store.delete(key)).toBe(false);
    expect(await store.listExpired()).toEqual([]);
    expect(store.describe()).toBe("s3://emrpdf-rh");
    expect(bucket.calls).toEqual(["HeadBucketCommand", "PutObjectCommand", "GetObjectCommand", "GetObjectCommand", "HeadObjectCommand", "DeleteObjectCommand", "HeadObjectCommand"]);
  });

  it("the lifecycle check recognises the bucket's existing 30-day rule and only adds ours when none exists", () => {
    const autodelete = { ID: "autodelete", Status: "Enabled" as const, Filter: { Prefix: "" }, Expiration: { Days: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 30 } };
    expect(findTtlRule([autodelete])?.ID).toBe("autodelete");
    expect(mergeTtlRule([autodelete])).toEqual({ rules: [autodelete], added: false, existing: "autodelete" });
    const wrongDays = { ...autodelete, ID: "weekly", Expiration: { Days: 7 } };
    const merged = mergeTtlRule([wrongDays]);
    expect(merged.added).toBe(true);
    expect(merged.rules.map((r) => r.ID)).toEqual(["weekly", RULE_ID]);
    expect(merged.rules[1]).toMatchObject({ Status: "Enabled", Expiration: { Days: 30 }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 30 } });
    expect(findTtlRule([{ ...autodelete, Status: "Disabled" }])).toBeUndefined();
    expect(findTtlRule([{ ...autodelete, Filter: { Prefix: "transcripts/" } }])).toBeUndefined();
    expect(mergeTtlRule(undefined).rules).toHaveLength(1);
  });

  it("DynamoDB Streams handler records TTL REMOVE events on sumId keys (userIdentity Service) and ignores user deletes, inserts, probe and receipt items", async () => {
    const a = newSumId();
    const b = newSumId();
    const ttl = { type: "Service", principalId: "dynamodb.amazonaws.com" };
    const event = {
      Records: [
        { eventName: "INSERT" as const, dynamodb: { Keys: { uid: { S: a } } } },
        { eventName: "REMOVE" as const, dynamodb: { Keys: { uid: { S: a } }, OldImage: { expiresAt: { N: "1794250337" } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: a } }, OldImage: { expiresAt: { N: "1794250337" }, "sum-id": { S: a } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: b } }, OldImage: { expiresAt: { N: "1794250400" } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: `receipt#${a}#abc` } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: "probe#0123456789abcdef" } } } },
      ],
    };
    expect(event.Records.map(isTtlDeletion)).toEqual([false, false, true, true, true, true]);
    const receipts = receiptsFromStreamEvent(event, () => new Date("2026-11-11T00:00:00.000Z"));
    expect(receipts).toEqual([
      expect.objectContaining({ sumId: a, uid: a, deleted: "record", mechanism: "dynamodb_ttl", source: "dynamodb-stream", expiresAt: 1794250337, at: "2026-11-11T00:00:00.000Z" }),
      expect.objectContaining({ sumId: b, uid: b, mechanism: "dynamodb_ttl", expiresAt: 1794250400 }),
    ]);
    const sink = new FileAuditSink(join(dir, "audit", "stream.jsonl"));
    expect(await streamHandler(event, sink)).toEqual({ receipts: 2 });
    expect((await sink.findBySumId(a)).map((r) => r.uid)).toEqual([a]);
    expect((await sink.list()).map((r) => r.sumId)).toEqual([a, b]);
  });

  it("S3 event handler records lifecycle expirations of PDF, audio and transcript objects and ignores uploads", async () => {
    const sumId = newSumId();
    const event = {
      Records: [
        { eventName: "ObjectCreated:Put", s3: { object: { key: `${sumId}.pdf` } } },
        { eventName: "LifecycleExpiration:Delete", s3: { object: { key: `${sumId}.pdf` } } },
        { eventName: "LifecycleExpiration:Delete", s3: { object: { key: `${sumId}.wav` } } },
        { eventName: "LifecycleExpiration:Delete", s3: { object: { key: "transcripts/dischargeai-abc.json" } } },
      ],
    };
    const receipts = receiptsFromS3Event(event, () => new Date("2026-11-11T00:00:00.000Z"));
    expect(receipts.map((r) => [r.sumId, r.deleted, r.mechanism, r.key])).toEqual([
      [sumId, "pdf", "s3_lifecycle", `${sumId}.pdf`],
      [sumId, "audio", "s3_lifecycle", `${sumId}.wav`],
      ["-", "transcript", "s3_lifecycle", "transcripts/dischargeai-abc.json"],
    ]);
    const sink = new FileAuditSink(join(dir, "audit", "s3.jsonl"));
    expect(await s3Handler(event, sink)).toEqual({ receipts: 3 });
    expect((await sink.findBySumId(sumId)).map((r) => r.deleted)).toEqual(["pdf", "audio"]);
  });

  it("refuses a receipt that would carry content", () => {
    expect(() => newReceipt({ sumId: "x", deleted: "audio", mechanism: "s3_lifecycle", source: "s3-event", key: "text: Furosemide" })).toThrow();
    expect(() => newReceipt({ sumId: "x", deleted: "record", mechanism: "purge_job", source: "purge", uid: "steps: take it" })).toThrow();
  });
});
