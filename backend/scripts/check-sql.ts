/**
 * Opens the configured SQL database, applies the migrations and prints what it found. Use it from a
 * host that can reach RDS on port 3306 (the team's EC2 box) to prove the MariaDB path:
 *   npm run check-sql                                   SQLite (default) or the Secrets Manager values
 *   DATABASE_URL='mysql://admin:<password>@patients.cleqcmkoulma.us-west-2.rds.amazonaws.com:3306/dischargeai' npm run check-sql
 * The password is never printed. Pass it through the environment, not on a shared command line.
 */
import { loadRuntimeEnv } from "../src/bootstrap.js";
import { loadConfig } from "../src/config.js";
import { openDb } from "../src/db/index.js";
import { migrate } from "../src/db/migrate.js";

const { env, secrets } = await loadRuntimeEnv();
const config = loadConfig(env);
const t0 = Date.now();
const db = await openDb(config);
const ran = await migrate(db);
const tables = ["patients", "links", "jobs", "audit_log", "documents", "schema_migrations"];
const counts: Record<string, number> = {};
for (const t of tables) counts[t] = Number((await db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${t}`))?.n ?? 0);
const version = db.dialect === "mysql" ? (await db.get<{ v: string }>("SELECT VERSION() AS v"))?.v : (await db.get<{ v: string }>("SELECT sqlite_version() AS v"))?.v;
await db.close();
console.log(JSON.stringify({ ok: true, dialect: db.dialect, connection: db.describe, serverVersion: version, configSource: secrets.source, fromSecret: secrets.applied, migrationsApplied: ran, counts, ms: Date.now() - t0 }, null, 2));
