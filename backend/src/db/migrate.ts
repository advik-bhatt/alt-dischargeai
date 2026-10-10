import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./index.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/** Applies `migrations/*.sql` in name order, once each, recording them in schema_migrations. */
export async function migrate(db: Db, now: () => string = () => new Date().toISOString()): Promise<string[]> {
  await db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const applied = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8");
    if (db.dialect === "pg") {
      await db.exec(sql.replace(/INTEGER PRIMARY KEY AUTOINCREMENT/g, "SERIAL PRIMARY KEY"));
    } else {
      await db.exec(sql);
    }
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, now()]);
    ran.push(file);
  }
  return ran;
}
