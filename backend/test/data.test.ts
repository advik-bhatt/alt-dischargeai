import { mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileAuditSink, newReceipt } from "../src/audit/receipts.js";
import { receiptsFromS3Event, handler as s3Handler } from "../src/audit/s3EventHandler.js";
import { handler as streamHandler, isTtlDeletion, receiptsFromStreamEvent } from "../src/audit/streamHandler.js";
import { LINK_TTL_DAYS } from "../src/config.js";
import { aadFor, sealToJson } from "../src/crypto/envelope.js";
import { deriveRecordKey, hashToken, newToken } from "../src/crypto/token.js";
import { LocalAudioStore, audioKeyFor } from "../src/data/audio.js";
import { LocalRecordStore } from "../src/data/local/records.js";
import type { DischargeRecord } from "../src/data/records.js";
import { runSweep } from "../src/data/sweeper.js";

const DAY = 24 * 60 * 60 * 1000;

function makeRecord(token: string, createdAt: Date, extra: Partial<DischargeRecord> = {}): DischargeRecord {
  const tokenHash = hashToken(token);
  const key = deriveRecordKey(token, 1);
  return {
    tokenHash,
    createdAt: createdAt.toISOString(),
    updatedAt: createdAt.toISOString(),
    expiresAt: Math.floor((createdAt.getTime() + LINK_TTL_DAYS * DAY) / 1000),
    status: "ready",
    language: "es",
    languages: ["en", "es"],
    inputKind: "text",
    keyVersion: 1,
    transcript: sealToJson(key, { text: "Furosemide 40 mg once daily" }, aadFor(tokenHash, "transcript", 1)),
    perLanguage: sealToJson(key, { en: { language: "en", steps: [], medications: [], followUps: [], warnings: [] } }, aadFor(tokenHash, "perLanguage", 1)),
    ...extra,
  };
}

describe("lane 4 data: discharge_records twin, audio twin, receipts, sweeper", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dischargeai-data-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("stores the DynamoDB item shape column for column, with expiresAt = createdAt + 30 days in epoch seconds", async () => {
    const store = new LocalRecordStore(":memory:");
    const token = newToken();
    const created = new Date("2026-10-10T12:00:00.000Z");
    const rec = makeRecord(token, created, { patientLabel: sealToJson(deriveRecordKey(token, 1), "bed 4", aadFor(hashToken(token), "patientLabel", 1)) });
    await store.put(rec);
    const got = await store.get(rec.tokenHash);
    expect(got).toEqual(rec);
    expect(got!.expiresAt).toBe(Math.floor(new Date("2026-11-09T12:00:00.000Z").getTime() / 1000));
    expect(JSON.stringify(got)).not.toContain("Furosemide");

    await store.update(rec.tokenHash, { status: "needs_review", statusReason: "safety_check_failed dropped=1 unsupported=0", pipeline: { provider: "offline" } });
    expect(await store.get(rec.tokenHash)).toMatchObject({ status: "needs_review", statusReason: "safety_check_failed dropped=1 unsupported=0", pipeline: { provider: "offline" } });

    expect(await store.listExpired(rec.expiresAt - 1)).toEqual([]);
    expect(await store.listExpired(rec.expiresAt)).toEqual([{ tokenHash: rec.tokenHash, expiresAt: rec.expiresAt, audioKey: undefined }]);
    expect(await store.delete(rec.tokenHash)).toBe(true);
    expect(await store.delete(rec.tokenHash)).toBe(false);
    expect(await store.get(rec.tokenHash)).toBeNull();
    await store.close();
  });

  it("finds records stuck in processing from before a restart", async () => {
    const store = new LocalRecordStore(":memory:");
    const old = makeRecord(newToken(), new Date(Date.now() - 2 * 60 * 60 * 1000), { status: "processing" });
    const fresh = makeRecord(newToken(), new Date(), { status: "processing" });
    await store.put(old);
    await store.put(fresh);
    expect(await store.listProcessingBefore(new Date(Date.now() - 10 * 60 * 1000).toISOString())).toEqual([old.tokenHash]);
    await store.close();
  });

  it("local audio twin: keys are tokenHash + extension, put/get/delete, lifecycle listing by write time", async () => {
    const audio = new LocalAudioStore(join(dir, "audio"));
    const hash = hashToken(newToken());
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

  it("sweeper deletes expired records and 30-day-old audio the way TTL and lifecycle would, and writes receipts without PHI", async () => {
    const records = new LocalRecordStore(":memory:");
    const audio = new LocalAudioStore(join(dir, "sweep-audio"));
    const audit = new FileAuditSink(join(dir, "audit", "receipts.jsonl"));
    const created = new Date("2026-10-10T12:00:00.000Z");
    const expiredToken = newToken();
    const expired = makeRecord(expiredToken, created, { audioKey: `${hashToken(expiredToken)}.wav`, inputKind: "audio" });
    const fresh = makeRecord(newToken(), new Date("2026-11-01T12:00:00.000Z"));
    await records.put(expired);
    await records.put(fresh);
    await audio.put({ key: expired.audioKey!, body: Buffer.from("old clip"), contentType: "audio/wav" });
    utimesSync(join(dir, "sweep-audio", expired.audioKey!), created, created);

    const nothing = await runSweep({ records, audio, audit }, new Date("2026-11-09T11:59:59.000Z"));
    expect(nothing).toMatchObject({ recordsDeleted: 0, audioDeleted: 0, receipts: [] });

    const day30 = new Date("2026-11-10T12:00:00.000Z");
    const report = await runSweep({ records, audio, audit }, day30);
    expect(report.recordsDeleted).toBe(1);
    expect(report.audioDeleted).toBe(1);
    expect(await records.get(expired.tokenHash)).toBeNull();
    expect(await records.get(fresh.tokenHash)).not.toBeNull();
    expect(await audio.get(expired.audioKey!)).toBeNull();

    const receipts = await audit.findByTokenHash(expired.tokenHash);
    expect(receipts.map((r) => [r.deleted, r.mechanism, r.source])).toEqual([
      ["record", "local_sweeper", "sweeper"],
      ["audio", "local_sweeper", "sweeper"],
    ]);
    expect(receipts[0]).toMatchObject({ tokenHash: expired.tokenHash, expiresAt: expired.expiresAt, at: day30.toISOString() });
    expect(receipts[1].key).toBe(expired.audioKey);
    const raw = JSON.stringify(await audit.list());
    expect(raw).not.toContain("Furosemide");
    expect(raw).not.toContain(expiredToken);
    expect(raw).not.toMatch(/"text"/);

    const again = await runSweep({ records, audio, audit }, day30);
    expect(again.receipts).toEqual([]);
    await records.close();
  });

  it("DynamoDB Streams handler records TTL REMOVE events (userIdentity Service) and ignores user deletes and inserts", async () => {
    const hash = hashToken(newToken());
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
    const hash = hashToken(newToken());
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
