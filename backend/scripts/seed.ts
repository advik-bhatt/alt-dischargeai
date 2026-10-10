/**
 * Local development only: writes the six synthetic patients (pt-0001 to pt-0006, @example.test
 * addresses) into the local SQLite patients table so the README's curl commands have someone to ingest
 * for. The server never seeds on its own. Against MySQL (the team's RDS, where `patientinfo` is the
 * real patient list) it refuses and writes nothing.
 *   npm run seed
 */
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { createContext } from "../src/context.js";
import { seedPatients } from "../src/db/seed.js";

const { env, secrets } = await loadRuntimeEnv();
const ctx = await createContext({ env: { ...env, LLM_PROVIDER: "offline", SPEECH_PROVIDER: "offline", PURGE_INTERVAL_MS: "0" }, secrets, resumeJobs: false });
try {
  const added = await seedPatients(ctx.patients, ctx.audit, () => ctx.clock.nowIso());
  console.log(JSON.stringify({ sql: ctx.db.describe, table: ctx.patients.table, added, patients: await ctx.patients.count() }));
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 2;
} finally {
  await ctx.close();
}
