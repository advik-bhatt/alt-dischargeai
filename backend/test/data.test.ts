import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileAuditSink, newReceipt } from "../src/audit/receipts.js";
import { receiptsFromS3Event, handler as s3Handler } from "../src/audit/s3EventHandler.js";
import { handler as streamHandler, isTtlDeletion, receiptsFromStreamEvent } from "../src/audit/streamHandler.js";
import { hashLinkId, newLinkId } from "../src/crypto/linkId.js";
import { LocalAudioStore, audioKeyFor } from "../src/data/audio.js";

const DAY = 24 * 60 * 60 * 1000;

describe("audio twin and deletion receipt handlers", () => {
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

  it("DynamoDB Streams handler records TTL REMOVE events (userIdentity Service) and ignores user deletes and inserts", async () => {
    const hash = hashLinkId(newLinkId());
    const event = {
      Records: [
        { eventName: "INSERT" as const, dynamodb: { Keys: { tokenHash: { S: hash } } } },
        { eventName: "REMOVE" as const, dynamodb: { Keys: { tokenHash: { S: hash } }, OldImage: { expiresAt: { N: "1794250337" } } } },
        {
          eventName: "REMOVE" as const,
          userIdentity: { type: "Service", principalId: "dynamodb.amazonaws.com" },
          dynamodb: { Keys: { tokenHash: { S: hash } }, OldImage: { expiresAt: { N: "1794250337" }, audioKey: { S: `${hash}.wav` } } },
        },
      ],
    };
    expect(event.Records.map(isTtlDeletion)).toEqual([false, false, true]);
    const receipts = receiptsFromStreamEvent(event, () => new Date("2026-11-11T00:00:00.000Z"));
    expect(receipts).toEqual([
      expect.objectContaining({ tokenHash: hash, deleted: "record", mechanism: "dynamodb_ttl", source: "dynamodb-stream", expiresAt: 1794250337, at: "2026-11-11T00:00:00.000Z" }),
    ]);
    const sink = new FileAuditSink(join(dir, "audit", "stream.jsonl"));
    expect(await streamHandler(event, sink)).toEqual({ receipts: 1 });
    expect((await sink.findByTokenHash(hash)).length).toBe(1);
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
    expect(receipts.map((r) => [r.tokenHash, r.deleted, r.mechanism, r.key])).toEqual([
      [hash, "audio", "s3_lifecycle", `${hash}.wav`],
      ["-", "transcript", "s3_lifecycle", "transcripts/dischargeai-abc.json"],
    ]);
    const sink = new FileAuditSink(join(dir, "audit", "s3.jsonl"));
    expect(await s3Handler(event, sink)).toEqual({ receipts: 2 });
  });

  it("refuses a receipt that would carry content", () => {
    expect(() => newReceipt({ tokenHash: "x", deleted: "audio", mechanism: "s3_lifecycle", source: "s3-event", key: "text: Furosemide" })).toThrow();
  });
});
