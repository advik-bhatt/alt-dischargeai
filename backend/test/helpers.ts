import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { buildApp } from "../src/app.js";
import { createContext, type AppContext, type CreateContextOptions } from "../src/context.js";
import type { Mailer, SentMail } from "../src/email/mailer.js";
import type { LinkEmail } from "../src/email/templates.js";

export const PROVIDER_KEY = "test-provider-key";
export const FIXTURES = join(import.meta.dirname, "..", "fixtures");

/** Seeded ids: pt-0001 Harold Jennings (en, caregiver June), pt-0002 Marisol Reyes (es, caregiver Diego), pt-0004 Dmitri Volkov (ru, no caregiver). */
export const PATIENT_EN = "pt-0001";
export const PATIENT_ES = "pt-0002";
export const PATIENT_NO_CAREGIVER = "pt-0004";

export function exampleText(name = "example-1-chf"): string {
  return readFileSync(join(FIXTURES, "discharge-summaries", `${name}.txt`), "utf8");
}

export function transcriptFixture(name = "dictation-1"): string {
  return (JSON.parse(readFileSync(join(FIXTURES, "offline", "transcripts", `${name}.json`), "utf8")) as { text: string }).text;
}

export function examplePdf(name = "example-1-chf"): Buffer {
  return readFileSync(join(FIXTURES, "discharge-summaries", `${name}.pdf`));
}

/** A mailer that records instead of printing, so tests can assert on what was sent. */
export function recordingMailer(): Mailer & { sent: LinkEmail[] } {
  const sent: LinkEmail[] = [];
  return {
    transportName: "console",
    sent,
    async send(mail: LinkEmail): Promise<SentMail> {
      sent.push(mail);
      return { messageId: `test-${sent.length}`, transport: "console", preview: { from: "test", to: mail.to, subject: mail.subject, text: mail.text } };
    },
  };
}

export interface TestApp {
  ctx: AppContext;
  app: ReturnType<typeof buildApp>;
  mailer: ReturnType<typeof recordingMailer>;
  /** Where the local PDF and audio twins write for this app. */
  dir: string;
  provider: (req: request.Test) => request.Test;
  close: () => Promise<void>;
}

export const TEST_ENV: Record<string, string> = {
  DATABASE_FILE: ":memory:",
  DATABASE_URL: "",
  LOG_LEVEL: "silent",
  PURGE_INTERVAL_MS: "0",
  PROVIDER_API_KEY: PROVIDER_KEY,
  LLM_PROVIDER: "offline",
  SPEECH_PROVIDER: "offline",
  DOC_STORE: "local",
  PDF_STORE: "local",
  AUDIO_STORE: "local",
  EMAIL_TRANSPORT: "console",
  EMAIL_QUEUE: "none",
};

export async function createTestApp(opts: CreateContextOptions = {}): Promise<TestApp> {
  const mailer = recordingMailer();
  const { env, ...rest } = opts;
  const dir = mkdtempSync(join(tmpdir(), "dischargeai-test-"));
  const ctx = await createContext({
    env: { ...process.env, ...TEST_ENV, PDF_DIR: join(dir, "pdf"), AUDIO_DIR: join(dir, "audio"), ...(env ?? {}) },
    mailer,
    // The suite runs on the six synthetic patients in an in-memory SQLite table; the server never seeds.
    seed: true,
    ...rest,
  });
  const app = buildApp(ctx);
  return {
    ctx,
    app,
    mailer,
    dir,
    provider: (req) => req.set("x-provider-key", PROVIDER_KEY),
    close: () => ctx.close(),
  };
}

export interface Ingested {
  patientId: string;
  jobId: string;
  sumId: string;
  linkId: string;
  link: string;
  expiresAt: string;
}

/** The team contract's JSON ingest for a seeded patient; waits for the pipeline to finish. */
export async function ingestText(t: TestApp, text: string, extra: Record<string, string> = {}, patientId: string = PATIENT_EN): Promise<Ingested> {
  const res = await t.provider(request(t.app).post("/ingest")).send({ data: text, type: "text", patientID: patientId, ...extra });
  if (res.status !== 202) throw new Error(`ingest failed: ${res.status} ${JSON.stringify(res.body)}`);
  await t.ctx.queue.onIdle();
  return { patientId, ...(res.body as Omit<Ingested, "patientId">) };
}

/** The team contract's JSON ingest of a PDF as base64. */
export async function ingestPdf(t: TestApp, pdf: Buffer, extra: Record<string, string> = {}, patientId: string = PATIENT_EN): Promise<Ingested> {
  const res = await t.provider(request(t.app).post("/ingest")).send({ data: pdf.toString("base64"), type: "pdf", patientID: patientId, ...extra });
  if (res.status !== 202) throw new Error(`ingest failed: ${res.status} ${JSON.stringify(res.body)}`);
  await t.ctx.queue.onIdle();
  return { patientId, ...(res.body as Omit<Ingested, "patientId">) };
}

export const AI_KEYS = ["language", "steps", "medications", "followUps", "warnings"];
export const VIEW_KEYS = [...AI_KEYS, "expiresAt", "daysLeft", "availableLanguages", "fromCache"];
export const LLM_SUMMARY_KEYS = ["sum-id", "sumId", "patientID", "language", "status", "llm-summary", "availableLanguages", "createdAt", "expiresAt", "daysLeft"];
export const TRANSLATION_KEYS = ["sum-id", "sumId", "lang", "fromCache", "translation", "availableLanguages", "expiresAt", "daysLeft"];
