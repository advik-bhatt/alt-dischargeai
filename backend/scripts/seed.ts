/** Seeds the six synthetic patients into the configured SQL database (SQLite, or MariaDB via Secrets Manager). Idempotent; also runs at boot. */
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { createContext } from "../src/context.js";

const { env, secrets } = await loadRuntimeEnv();
const ctx = await createContext({ env: { ...env, LLM_PROVIDER: "offline", SPEECH_PROVIDER: "offline", PURGE_INTERVAL_MS: "0" }, secrets, resumeJobs: false });
const count = await ctx.patients.count();
console.log(JSON.stringify({ configSource: secrets.source, sql: ctx.db.describe, patients: count }));
await ctx.close();
