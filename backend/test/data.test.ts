import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileAuditSink, newReceipt } from "../src/audit/receipts.js";
import { receiptsFromS3Event, handler as s3Handler } from "../src/audit/s3EventHandler.js";
import { handler as streamHandler, isTtlDeletion, receiptsFromStreamEvent } from "../src/audit/streamHandler.js";
import { hashLinkId, newLinkId } from "../src/crypto/linkId.js";
import { LocalAudioStore, audioKeyFor } from "../src/data/audio.js";
import { S3AudioStore, type S3Like } from "../src/data/s3/audio.js";
import { findTtlRule, mergeTtlRule, RULE_ID } from "../scripts/ensure-s3-lifecycle.js";

const DAY = 24 * 60 * 60 * 1000;

/** An in-memory bucket that answers like S3 (404 NotFound on missing heads). */
function fakeBucket() {
  const objects = new Map<string, { body: Buffer; contentType?: string; sse?: string }>();
  const calls: string[] = [];
  const client: S3Like = {
    async send(cmd) {
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

describe("audio stores, lifecycle rule and deletion receipt handlers", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dischargeai-data-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("local audio twin: keys are the link hash plus extension, put/get/delete, lifecycle listing by write time", async () => {
    const audio = new LocalAudioStore(join(dir, "audio"));
    const hash = hashLinkId(newLinkId());
    const key = audioKeyFor(hash, "audio/wav", "clip.wav");
    expect(key).toBe(`${hash}.wav`);
    expect(audioKeyFor(hash, "application/octet-stream", "voice.webm")).toBe(`${hash}.webm`);
    expect(audioKeyFor(hash, "application/octet-stream")).toBe(`${hash}.bin`);
    await audio.put({ key, body: Buffer.from("RIFF fake"), contentType: "audio/wav" });
    expect((await audio.get(key))?.body.toString()).toBe("RIFF fake");
    expect((await audio.get(key))?.contentType).toBe("audio/wav");
    expect(await audio.listExpired(new Date())).toEqual([]);
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * DAY);
    utimesSync(join(dir, "audio", key), thirtyOneDaysAgo, thirtyOneDaysAgo);
    expect(await audio.listExpired(new Date())).toEqual([{ key, createdAt: expect.any(String) }]);
    expect(await audio.delete(key)).toBe(true);
    expect(await audio.delete(key)).toBe(false);
    expect(await audio.get(key)).toBeNull();
    await expect(audio.get("../etc/passwd")).rejects.toThrow("invalid audio key");
  });

  it("S3 audio store: writes with SSE-S3 (AES256), reads back, delete reports whether anything was there", async () => {
    const bucket = fakeBucket();
    const store = new S3AudioStore({ bucket: "emraudio-rh", region: "us-west-2", client: bucket.client });
    await store.headBucket();
    const hash = hashLinkId(newLinkId());
    const key = audioKeyFor(hash, "audio/webm");
    await store.put({ key, body: Buffer.from("webm bytes"), contentType: "audio/webm" });
    expect(bucket.objects.get(key)).toMatchObject({ contentType: "audio/webm", sse: "AES256" });
    expect((await store.get(key))?.body.toString()).toBe("webm bytes");
    expect(await store.get(`${hash}.mp3`)).toBeNull();
    expect(await store.delete(key)).toBe(true);
    expect(await store.delete(key)).toBe(false);
    expect(await store.listExpired()).toEqual([]);
    expect(store.describe()).toBe("s3://emraudio-rh");
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

  it("DynamoDB Streams handler records TTL REMOVE events on uid keys (userIdentity Service), ignores user deletes, inserts and receipt items", async () => {
    const hash = hashLinkId(newLinkId());
    const ttl = { type: "Service", principalId: "dynamodb.amazonaws.com" };
    const event = {
      Records: [
        { eventName: "INSERT" as const, dynamodb: { Keys: { uid: { S: `${hash}#raw` } } } },
        { eventName: "REMOVE" as const, dynamodb: { Keys: { uid: { S: `${hash}#raw` } }, OldImage: { expiresAt: { N: "1794250337" } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: `${hash}#simplified` } }, OldImage: { expiresAt: { N: "1794250337" }, sk: { S: "simplified" } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: `${hash}#translation#es` } }, OldImage: { expiresAt: { N: "1794250337" } } } },
        { eventName: "REMOVE" as const, userIdentity: ttl, dynamodb: { Keys: { uid: { S: `receipt#${hash}#abc` } } } },
      ],
    };
    expect(event.Records.map(isTtlDeletion)).toEqual([false, false, true, true, true]);
    const receipts = receiptsFromStreamEvent(event, () => new Date("2026-11-11T00:00:00.000Z"));
    expect(receipts).toEqual([
      expect.objectContaining({ linkIdHash: hash, uid: `${hash}#simplified`, deleted: "record", mechanism: "dynamodb_ttl", source: "dynamodb-stream", expiresAt: 1794250337, at: "2026-11-11T00:00:00.000Z" }),
      expect.objectContaining({ linkIdHash: hash, uid: `${hash}#translation#es`, mechanism: "dynamodb_ttl" }),
    ]);
    const sink = new FileAuditSink(join(dir, "audit", "stream.jsonl"));
    expect(await streamHandler(event, sink)).toEqual({ receipts: 2 });
    expect((await sink.findByLinkIdHash(hash)).map((r) => r.uid)).toEqual([`${hash}#simplified`, `${hash}#translation#es`]);
  });

  it("S3 event handler records lifecycle expirations of audio and transcript objects and ignores uploads", async () => {
    const hash = hashLinkId(newLinkId());
    const event = {
      Records: [
        { eventName: "ObjectCreated:Put", s3: { object: { key: `${hash}.wav` } } },
        { eventName: "LifecycleExpiration:Delete", s3: { object: { key: `${hash}.wav` } } },
        { eventName: "LifecycleExpiration:Delete", s3: { object: { key: "transcripts/dischargeai-abc.json" } } },
      ],
    };
    const receipts = receiptsFromS3Event(event, () => new Date("2026-11-11T00:00:00.000Z"));
    expect(receipts.map((r) => [r.linkIdHash, r.deleted, r.mechanism, r.key])).toEqual([
      [hash, "audio", "s3_lifecycle", `${hash}.wav`],
      ["-", "transcript", "s3_lifecycle", "transcripts/dischargeai-abc.json"],
    ]);
    const sink = new FileAuditSink(join(dir, "audit", "s3.jsonl"));
    expect(await s3Handler(event, sink)).toEqual({ receipts: 2 });
  });

  it("refuses a receipt that would carry content", () => {
    expect(() => newReceipt({ linkIdHash: "x", deleted: "audio", mechanism: "s3_lifecycle", source: "s3-event", key: "text: Furosemide" })).toThrow();
    expect(() => newReceipt({ linkIdHash: "x", deleted: "record", mechanism: "purge_job", source: "purge", uid: "steps: take it" })).toThrow();
  });
});
