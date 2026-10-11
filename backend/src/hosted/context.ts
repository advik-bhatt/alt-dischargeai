import { randomUUID } from "node:crypto";
import { SqlAuditSink } from "../audit/receipts.js";
import { Clock } from "../clock.js";
import { LINK_TTL_DAYS, loadConfig, type Config } from "../config.js";
import { NO_SECRETS, type AppContext } from "../context.js";
import { ActiveLinksRepo } from "../db/repos/activeLinks.js";
import { AuditRepo } from "../db/repos/audit.js";
import { JobsRepo } from "../db/repos/jobs.js";
import { PatientsRepo } from "../db/repos/patients.js";
import { createMailer } from "../email/mailer.js";
import { createLogger } from "../logger.js";
import { DischargeAgent, type AgentProvider } from "../pipeline/agent.js";
import { runIngestJob } from "../pipeline/ingestJob.js";
import { MedicalLiveDictation } from "../pipeline/liveDictation.js";
import { runPurge } from "../pipeline/purge.js";
import { JobQueue } from "../pipeline/queue.js";
import { ElevenLabsReadAloud } from "../pipeline/readAloud.js";
import { createSpeechToText } from "../pipeline/speechToText.js";
import { AiInfraTranslator } from "../pipeline/translation.js";
import { PostgresDb, PostgresObjects, PostgresSummaries } from "./postgres.js";

/**
 * The hosted deployment (a container on Vercel): the same app as `npm run local:ai`, with the local
 * SQLite file replaced by Postgres so plans, patients and files outlive the instance. AI, dictation,
 * translation and read-aloud are the live providers when their credentials are set, and say so when
 * they are not; nothing falls back to a fixture.
 */

/** The patient URL base: PATIENT_APP_URL, else the Vercel production domain, else this server. */
export function hostedPatientUrl(env: Record<string, string | undefined>, port: number): string {
  if (env.PATIENT_APP_URL) return env.PATIENT_APP_URL.replace(/\/$/, "");
  if (env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `http://localhost:${port}`;
}

/**
 * Vercel does not pass AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_SESSION_TOKEN set in project
 * settings through to the container (the first hosted run failed with "Could not load credentials from
 * any providers"), so the hosted mode takes them as DISCHARGEAI_AWS_* and copies them into the standard
 * names before any AWS client exists. The SDK and the Python translator then read them as usual.
 * Returns where the credentials came from, by name only.
 */
export function applyHostedAwsCredentials(env: Record<string, string | undefined> = process.env): "DISCHARGEAI_AWS_*" | "AWS_*" | "none" {
  if (env.DISCHARGEAI_AWS_ACCESS_KEY_ID && env.DISCHARGEAI_AWS_SECRET_ACCESS_KEY) {
    env.AWS_ACCESS_KEY_ID = env.DISCHARGEAI_AWS_ACCESS_KEY_ID;
    env.AWS_SECRET_ACCESS_KEY = env.DISCHARGEAI_AWS_SECRET_ACCESS_KEY;
    if (env.DISCHARGEAI_AWS_SESSION_TOKEN) env.AWS_SESSION_TOKEN = env.DISCHARGEAI_AWS_SESSION_TOKEN;
    else delete env.AWS_SESSION_TOKEN;
    return "DISCHARGEAI_AWS_*";
  }
  return env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY ? "AWS_*" : "none";
}

/** AgentCore needs an explicit runtime ARN here: the team default in config.ts is another account's. */
function hostedAgent(env: Record<string, string | undefined>, config: Config): AgentProvider {
  const runtimeArn = env.AGENT_RUNTIME_ARN?.trim();
  const target = runtimeArn?.match(/^arn:aws(?:-us-gov|-cn)?:bedrock-agentcore:([a-z0-9-]+):(\d{12}):runtime\/([A-Za-z0-9_-]+)$/);
  if (!runtimeArn || !target) {
    return {
      name: "unconfigured", runtimeArn: "unset",
      async invoke() { throw new Error("AI is not configured on this server: set AGENT_RUNTIME_ARN and AWS credentials."); },
    };
  }
  return new DischargeAgent({ runtimeArn, region: target[1], timeoutMs: config.AGENT_TIMEOUT_MS, qualifier: config.AGENT_QUALIFIER });
}

/** `agent` replaces the AgentCore provider in tests only. */
export async function createHostedContext(env: Record<string, string | undefined> = process.env, opts: { agent?: AgentProvider } = {}): Promise<AppContext> {
  const port = Number(env.PORT ?? "80");
  const config = loadConfig(env, { HOST: "0.0.0.0", PORT: port, SECRETS_BOOTSTRAP: "off", PATIENT_APP_URL: hostedPatientUrl(env, port) });
  if (!config.POSTGRES_URL) throw new Error("POSTGRES_URL is required in hosted mode (postgres://user:password@host:port/database).");
  if (config.PROVIDER_API_KEY === "dev-provider-key") throw new Error("Set PROVIDER_API_KEY to a long random value in hosted mode; the development default is public.");
  const log = createLogger(config.LOG_LEVEL);
  const db = await PostgresDb.connect(config.POSTGRES_URL, config.MYSQL_POOL_SIZE);
  // The two synthetic demo patients the login screen's patient and caregiver codes point at.
  for (const [id, first, last] of [["7", "Alex", "Example"], ["8", "Jordan", "Sample"]]) {
    await db.run("INSERT INTO patientinfo (ID, DOB, FirstName, LastName, email, caregiverEmail, preferredLanguage) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
      [id, "2000-01-01", first, last, `patient-${id}@example.test`, `caregiver-${id}@example.test`, "en"]);
  }
  const patients = new PatientsRepo(db, config.PATIENTS_TABLE);
  await patients.init();
  const audit = new AuditRepo(db);
  const jobs = new JobsRepo(db);
  const queue = new JobQueue();
  const agent = opts.agent ?? hostedAgent(env, config);
  const speech = config.SPEECH_PROVIDER === "healthscribe" && config.HEALTHSCRIBE_BUCKET && config.HEALTHSCRIBE_ROLE_ARN ? await createSpeechToText(config, log) : undefined;
  let purgeTimer: NodeJS.Timeout | undefined;

  const ctx: AppContext = {
    mode: "hosted", config, log, clock: new Clock(config.DEMO_NOW), linkTtlDays: LINK_TTL_DAYS,
    secrets: { ...NO_SECRETS, reason: "hosted: configuration from the environment" },
    db, patients, audit, jobs, activeLinks: new ActiveLinksRepo(db), receipts: new SqlAuditSink(audit),
    summaries: new PostgresSummaries(db), pdf: new PostgresObjects(db, "pdf"), audio: new PostgresObjects(db, "audio"),
    agent,
    speechToText: speech ?? { name: "unavailable", async transcribe() { throw new Error("Recorded audio is not configured on this server. Paste notes, upload a readable PDF, or use live dictation."); } },
    liveDictation: new MedicalLiveDictation(config.TRANSCRIBE_STREAMING_REGION),
    translator: config.TRANSLATION_PROVIDER === "ai-infra" ? new AiInfraTranslator(config) : undefined,
    readAloud: config.ELEVENLABS_API_KEY ? new ElevenLabsReadAloud(config) : undefined,
    mailer: await createMailer(config, log),
    queue,
    patientUrl: (sumId) => `${config.PATIENT_APP_URL}/s/${sumId}`,
    enqueueIngest: (jobId, pending) => queue.add(jobId, () => runIngestJob(ctx, jobId, pending)),
    purge: () => runPurge(ctx),
    startPurgeTimer: () => {
      if (purgeTimer || config.PURGE_INTERVAL_MS <= 0) return;
      purgeTimer = setInterval(() => {
        runPurge(ctx).catch((err) => log.error({ err: { message: (err as Error).message } }, "purge failed"));
        resumeStaleJobs().catch((err) => log.error({ err: { message: (err as Error).message } }, "job resume failed"));
      }, config.PURGE_INTERVAL_MS);
      purgeTimer.unref();
    },
    close: async () => {
      if (purgeTimer) clearInterval(purgeTimer);
      await queue.onIdle();
      await db.close();
    },
  };

  // Several instances can run at once and any of them can be stopped mid-job. A job is picked up again
  // only once nobody can still be working on it: no stage change for longer than one agent run may take.
  const staleAfterMs = config.AGENT_TIMEOUT_MS + 60_000;
  async function resumeStaleJobs() {
    const now = ctx.clock.now().getTime();
    for (const job of await jobs.listUnfinished()) {
      if (now - Date.parse(job.updatedAt) < staleAfterMs) continue;
      log.info({ jobId: job.id, stage: job.stage }, "resuming stale job");
      ctx.enqueueIngest(job.id);
    }
  }
  await resumeStaleJobs();
  log.info({ sql: db.describe, agent: agent.name, patientUrl: config.PATIENT_APP_URL, mailer: ctx.mailer.transportName, instance: randomUUID().slice(0, 8) }, "hosted context ready");
  return ctx;
}
