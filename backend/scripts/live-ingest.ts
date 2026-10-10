/**
 * Live Bedrock run of the whole note path: ingests Example 1 (CHF) with LLM_PROVIDER=bedrock for the
 * provider-picked language (Spanish), reads it back in English and Spanish, translates to Mandarin on
 * demand, and writes the result (fixed JSON per language, safety-check result, token usage, latency)
 * to fixtures/live-samples/. AWS credentials come from the shell environment only and are never read,
 * printed or written by this script. SQL and the document store are in-memory here, so nothing of
 * this run is left in the team account.
 *
 *   LLM_PROVIDER=bedrock npm run live-ingest                               # default model from BEDROCK_MODEL_ID
 *   BEDROCK_MODEL_ID=us.anthropic.claude-haiku-4-5-20251001-v1:0 npm run live-ingest
 *   npm run live-ingest -- example-2-sepsis-uti Spanish zh
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/app.js";
import { createContext } from "../src/context.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const provider = process.env.LLM_PROVIDER ?? "bedrock";
if (provider === "offline") {
  console.error("Set LLM_PROVIDER=bedrock (or anthropic) for a live run; offline would only reproduce the fixture.");
  process.exit(2);
}

const root = join(import.meta.dirname, "..");
const example = process.argv[2] ?? "example-1-chf";
const language = process.argv[3] ?? "Spanish";
const onDemand = process.argv[4] ?? "zh";
const text = readFileSync(join(root, "fixtures", "discharge-summaries", `${example}.txt`), "utf8");

const ctx = await createContext({
  env: { ...process.env, LLM_PROVIDER: provider, DATABASE_URL: "sqlite::memory:", DOC_STORE: "local", AUDIO_STORE: "local", AUDIT_SINK: "sql", EMAIL_TRANSPORT: "console", EMAIL_QUEUE: "none", PURGE_INTERVAL_MS: "0", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn", PROVIDER_API_KEY: "live-run", SECRETS_BOOTSTRAP: "off" },
  resumeJobs: false,
});
const app = buildApp(ctx);
const server = app.listen(0);
const port = (server.address() as AddressInfo).port;
const base = `http://127.0.0.1:${port}`;
const key = { "x-provider-key": "live-run" };
const get = async (path: string, headers: Record<string, string> = {}) => {
  const r = await fetch(`${base}${path}`, { headers });
  return { status: r.status, body: (await r.json()) as Record<string, unknown> };
};

const t0 = Date.now();
const patients = (await get("/patients", key)).body as { patients: { id: string }[] };
const form = new FormData();
form.set("patientId", patients.patients[0].id);
form.set("text", text);
form.set("language", language);
const accepted = (await (await fetch(`${base}/ingest`, { method: "POST", headers: key, body: form })).json()) as { jobId: string; linkId: string; language: string };
await ctx.queue.onIdle();
const job = (await get(`/jobs/${accepted.jobId}`, key)).body;
const en = await get(`/p/${accepted.linkId}`);
const picked = await get(`/p/${accepted.linkId}?language=${encodeURIComponent(accepted.language)}`);
const extra1 = await get(`/translate?link=${accepted.linkId}&language=${onDemand}`);
const extra2 = await get(`/translate?link=${accepted.linkId}&language=${onDemand}`);
server.close();
await ctx.close();

const modelId = provider === "bedrock" ? ctx.config.BEDROCK_MODEL_ID : ctx.config.ANTHROPIC_MODEL;
const date = new Date().toISOString();
const strip = (b: Record<string, unknown>) => {
  const { expiresAt: _e, daysLeft: _d, ...rest } = b;
  return rest;
};
const out = {
  verified: `live on ${provider}`,
  provider,
  modelId,
  region: provider === "bedrock" ? ctx.config.AWS_REGION : undefined,
  date,
  example,
  pickedLanguage: accepted.language,
  onDemandLanguage: onDemand,
  wallMs: Date.now() - t0,
  job: { stage: job.stage, verified: job.verified, languages: job.languages, safety: job.safety, meta: job.meta },
  english: en.status === 200 ? strip(en.body) : { status: en.status, body: en.body },
  picked: picked.status === 200 ? strip(picked.body) : { status: picked.status, body: picked.body },
  onDemand: {
    first: extra1.status === 200 ? strip(extra1.body) : { status: extra1.status, body: extra1.body },
    secondFromCache: extra2.status === 200 ? extra2.body.fromCache : null,
  },
};
const dir = join(root, "fixtures", "live-samples");
mkdirSync(dir, { recursive: true });
const file = join(dir, `${example}.${provider}.${modelId.replace(/[^A-Za-z0-9.-]+/g, "_")}.${date.slice(0, 10)}.json`);
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(
  JSON.stringify(
    {
      file,
      stage: job.stage,
      verified: job.verified,
      languages: job.languages,
      safety: job.safety ? { passed: (job.safety as { passed: boolean }).passed, reason: (job.safety as { reason?: string }).reason ?? null, translations: (job.safety as { translations: unknown[] }).translations } : null,
      meta: job.meta,
      english: en.status,
      picked: `${picked.status} fromCache=${picked.body.fromCache}`,
      onDemand: `${extra1.status} fromCache=${extra1.body.fromCache} then fromCache=${extra2.body.fromCache}`,
      wallMs: out.wallMs,
    },
    null,
    2,
  ),
);
process.exit(job.stage === "failed" ? 1 : 0);
