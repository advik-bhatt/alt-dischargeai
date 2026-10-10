/**
 * Runs the 30-day self-destruct once against the configured stores and prints what it did:
 *   npm run sweep                                  real clock: purges links whose expiry has passed
 *   DEMO_NOW=2026-11-11T00:00:00Z npm run sweep    demo: the clock is pinned 31 days ahead, so links
 *                                                  created today expire now; keys are destroyed,
 *                                                  document-store items and audio deleted, receipts written
 * Uses the same .env / Secrets Manager configuration as the server, so it works on the SQLite + local
 * twin in development and on RDS + DynamoDB + S3 in the team account. One-shot: it never resumes jobs.
 */
import { createContext } from "../src/context.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const ctx = await createContext({
  env: { ...process.env, LLM_PROVIDER: "offline", SPEECH_PROVIDER: "offline", EMAIL_TRANSPORT: "console", EMAIL_QUEUE: "none", PURGE_INTERVAL_MS: "0", LOG_LEVEL: process.env.LOG_LEVEL ?? "warn" },
  seed: false,
  resumeJobs: false,
});
const report = await ctx.purge();
console.log(JSON.stringify({ clock: { now: ctx.clock.nowIso(), demoNow: ctx.clock.demoNow, offsetDays: ctx.clock.offsetDays }, sql: ctx.db.dialect, docStore: ctx.docStore.name, ...report }, null, 2));
await ctx.close();
