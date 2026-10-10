/** Seeds the six synthetic patients into the configured SQL database. Idempotent; also runs at boot. */
import { createContext } from "../src/context.js";
import { loadDotEnv } from "../src/dotenv.js";

loadDotEnv();
const ctx = await createContext({ env: { ...process.env, LLM_PROVIDER: "offline", SPEECH_PROVIDER: "offline", PURGE_INTERVAL_MS: "0" } });
const count = await ctx.patients.count();
console.log(JSON.stringify({ sql: ctx.db.dialect, patients: count }));
await ctx.close();
