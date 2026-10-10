import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { LINK_TTL_DAYS } from "../config.js";
import type { Logger } from "../logger.js";

/**
 * The two team buckets, behind one store shape:
 *   emrpdf-rh    the PDF the provider ingested, key `<sumId>.pdf` (the team contract: "push to s3bucket emrpdf-rh")
 *   emraudio-rh  dictated audio, key `<sumId>.<ext>` ("EMR audio", from the diagram)
 * Both carry a 30-day lifecycle rule (scripts/setup-s3.ts ensures it) and every object is written
 * with server-side encryption. The local twin writes under backend/data/{pdf,audio}/ and the purge
 * job deletes files 30 days after they were written, the way the lifecycle rule would.
 */
export interface StoredObject {
  key: string;
  body: Buffer;
  contentType?: string;
}

export interface ExpiredObjectRef {
  key: string;
  createdAt: string;
}

export interface ObjectStore {
  readonly name: "local" | "s3";
  put(input: StoredObject): Promise<void>;
  get(key: string): Promise<StoredObject | null>;
  /** Returns false when nothing was there. */
  delete(key: string): Promise<boolean>;
  /** Local twin of the lifecycle rule: objects written more than ttlDays before `now`. S3 does this itself and returns []. */
  listExpired(now: Date, ttlDays?: number): Promise<ExpiredObjectRef[]>;
  /** Where the bytes live, for logs and the health endpoint (no PHI). */
  describe(): string;
}

export const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "audio/amr": "amr",
};

const MIME_BY_EXT: Record<string, string> = { pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", webm: "audio/webm", amr: "audio/amr" };

/** Object keys are `<sumId>.<ext>`: the 22-character link path plus a short extension, nothing about the patient. */
export const OBJECT_KEY_RE = /^([A-Za-z0-9_-]{22})\.([a-z0-9]{2,5})$/;

export function pdfKeyFor(sumId: string): string {
  return `${sumId}.pdf`;
}

export function audioKeyFor(sumId: string, mimeType: string, fileName?: string): string {
  const byMime = EXT_BY_MIME[mimeType.toLowerCase().split(";")[0]];
  const byName = fileName?.split(".").pop()?.toLowerCase();
  const ext = byMime ?? (byName && /^[a-z0-9]{2,5}$/.test(byName) ? byName : "bin");
  return `${sumId}.${ext}`;
}

/** Which bucket an object key belongs to, by extension; receipts use it to say what was deleted. */
export function objectKindFor(key: string): "pdf" | "audio" | undefined {
  const m = OBJECT_KEY_RE.exec(key);
  if (!m) return undefined;
  return m[2] === "pdf" ? "pdf" : "audio";
}

export class LocalObjectStore implements ObjectStore {
  readonly name = "local" as const;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(key: string): string {
    if (!OBJECT_KEY_RE.test(key)) throw new Error("invalid object key");
    return join(this.dir, key);
  }

  async put(input: StoredObject): Promise<void> {
    writeFileSync(this.pathFor(input.key), input.body);
  }

  async get(key: string): Promise<StoredObject | null> {
    const file = this.pathFor(key);
    if (!existsSync(file)) return null;
    return { key, body: readFileSync(file), contentType: MIME_BY_EXT[key.split(".").pop() ?? ""] };
  }

  async delete(key: string): Promise<boolean> {
    const file = this.pathFor(key);
    if (!existsSync(file)) return false;
    rmSync(file);
    return true;
  }

  async listExpired(now: Date, ttlDays = LINK_TTL_DAYS): Promise<ExpiredObjectRef[]> {
    const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
    const out: ExpiredObjectRef[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!OBJECT_KEY_RE.test(name)) continue;
      const st = statSync(join(this.dir, name));
      if (st.mtimeMs <= cutoff) out.push({ key: name, createdAt: new Date(st.mtimeMs).toISOString() });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  describe(): string {
    return `local:${this.dir}`;
  }
}

export interface ObjectStoreStatus {
  /** What the configuration asked for after resolving `auto`. */
  requested: "local" | "s3";
  /** What is actually in use. */
  active: "local" | "s3";
  bucket: string;
  /** Set when S3 was requested but the bucket could not be reached at boot. */
  fallbackReason?: string;
}

/** s3 -> the bucket; local -> the twin; auto -> s3 when Secrets Manager resolved (the team account is in reach). */
export function resolveObjectStore(mode: "auto" | "local" | "s3", secretResolved: boolean): "local" | "s3" {
  if (mode === "auto") return secretResolved ? "s3" : "local";
  return mode;
}

/**
 * Builds one object store. For S3 the bucket is probed once (HeadBucket, 5 s); if it is unreachable
 * the local twin takes over and the reason is reported in /health instead of failing the boot.
 */
export async function createObjectStore(input: { mode: "local" | "s3"; bucket: string; dir: string; region: string; label: string; log?: Logger }): Promise<{ store: ObjectStore; status: ObjectStoreStatus }> {
  const { bucket, dir, label } = input;
  if (input.mode === "s3") {
    const { S3ObjectStore } = await import("./s3/objects.js");
    const s3 = new S3ObjectStore({ bucket, region: input.region });
    try {
      await s3.headBucket(5000);
      input.log?.info({ bucket, store: label }, "object store: S3 bucket reachable");
      return { store: s3, status: { requested: "s3", active: "s3", bucket } };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const fallbackReason = `${e?.name ?? "Error"}: ${String(e?.message ?? err).slice(0, 160)}`;
      input.log?.warn({ bucket, store: label, reason: fallbackReason, dir }, "object store: S3 bucket unreachable, using the local twin");
      return { store: new LocalObjectStore(dir), status: { requested: "s3", active: "local", bucket, fallbackReason } };
    }
  }
  return { store: new LocalObjectStore(dir), status: { requested: "local", active: "local", bucket } };
}

/** The two stores the app wires: the PDF bucket (contract) and the audio bucket (diagram). */
export async function createObjectStores(config: Config, secretResolved: boolean, log?: Logger) {
  const pdf = await createObjectStore({ mode: resolveObjectStore(config.PDF_STORE, secretResolved), bucket: config.PDF_BUCKET, dir: config.PDF_DIR, region: config.AWS_REGION, label: "pdf", log });
  const audio = await createObjectStore({ mode: resolveObjectStore(config.AUDIO_STORE, secretResolved), bucket: config.AUDIO_BUCKET, dir: config.AUDIO_DIR, region: config.AWS_REGION, label: "audio", log });
  return { pdf, audio };
}
