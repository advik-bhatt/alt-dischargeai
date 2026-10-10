import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { LINK_TTL_DAYS } from "../config.js";

/**
 * Lane 4: the S3 audio bucket (lifecycle: delete day 30). Keys are `<tokenHash>.<ext>`, so an
 * object name reveals nothing about the patient. The local twin writes under backend/data/audio/
 * and the sweeper deletes files 30 days after they were written, the way the lifecycle rule would.
 */
export interface AudioObject {
  key: string;
  body: Buffer;
  contentType?: string;
}

export interface ExpiredAudioRef {
  key: string;
  createdAt: string;
}

export interface AudioStore {
  readonly name: "local" | "s3";
  put(input: AudioObject): Promise<void>;
  get(key: string): Promise<AudioObject | null>;
  /** Returns false when nothing was there. */
  delete(key: string): Promise<boolean>;
  /** Local twin of the lifecycle rule: objects written more than ttlDays before `now`. S3 does this itself and returns []. */
  listExpired(now: Date, ttlDays?: number): Promise<ExpiredAudioRef[]>;
  /** Where the bytes live, for logs and the health endpoint (no PHI). */
  describe(): string;
}

export const EXT_BY_MIME: Record<string, string> = {
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

const MIME_BY_EXT: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", webm: "audio/webm", amr: "audio/amr" };

export function audioKeyFor(tokenHash: string, mimeType: string, fileName?: string): string {
  const byMime = EXT_BY_MIME[mimeType.toLowerCase().split(";")[0]];
  const byName = fileName?.split(".").pop()?.toLowerCase();
  const ext = byMime ?? (byName && /^[a-z0-9]{2,5}$/.test(byName) ? byName : "bin");
  return `${tokenHash}.${ext}`;
}

const KEY_RE = /^[0-9a-f]{64}\.[a-z0-9]{2,5}$/;

export class LocalAudioStore implements AudioStore {
  readonly name = "local" as const;

  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private pathFor(key: string): string {
    if (!KEY_RE.test(key)) throw new Error("invalid audio key");
    return join(this.dir, key);
  }

  async put(input: AudioObject): Promise<void> {
    writeFileSync(this.pathFor(input.key), input.body);
  }

  async get(key: string): Promise<AudioObject | null> {
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

  async listExpired(now: Date, ttlDays = LINK_TTL_DAYS): Promise<ExpiredAudioRef[]> {
    const cutoff = now.getTime() - ttlDays * 24 * 60 * 60 * 1000;
    const out: ExpiredAudioRef[] = [];
    for (const name of readdirSync(this.dir)) {
      if (!KEY_RE.test(name)) continue;
      const st = statSync(join(this.dir, name));
      if (st.mtimeMs <= cutoff) out.push({ key: name, createdAt: new Date(st.mtimeMs).toISOString() });
    }
    return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  describe(): string {
    return `local:${this.dir}`;
  }
}

export async function createAudioStore(config: Config): Promise<AudioStore> {
  if (config.AUDIO_STORE === "s3") {
    const { S3AudioStore } = await import("./s3/audio.js");
    if (!config.AUDIO_BUCKET) throw new Error("AUDIO_STORE=s3 needs AUDIO_BUCKET");
    return new S3AudioStore({ bucket: config.AUDIO_BUCKET, region: config.AWS_REGION });
  }
  return new LocalAudioStore(config.AUDIO_DIR);
}
