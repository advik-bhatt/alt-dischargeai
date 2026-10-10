import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, type Db, type Dialect } from "./index.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/**
 * The migrations are written once, in portable SQL, and rewritten per dialect here:
 *   MySQL/MariaDB: AUTOINCREMENT -> AUTO_INCREMENT; BLOB -> LONGBLOB (ciphertext can exceed 64 KB);
 *                  TEXT -> MEDIUMTEXT (JSON blobs); CREATE INDEX IF NOT EXISTS -> CREATE INDEX
 *                  (MariaDB accepts IF NOT EXISTS, MySQL 8 does not; a duplicate index is ignored instead).
 *   SQLite: as written.
 */
export function toDialect(sql: string, dialect: Dialect): string {
  if (dialect !== "mysql") return sql;
  return sql
    .replace(/\bAUTOINCREMENT\b/g, "AUTO_INCREMENT")
    .replace(/\bBLOB\b/g, "LONGBLOB")
    .replace(/\bTEXT\b/g, "MEDIUMTEXT")
    .replace(/CREATE INDEX IF NOT EXISTS/g, "CREATE INDEX");
}

function isDuplicateIndex(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === "ER_DUP_KEYNAME" || e?.errno === 1061;
}

/** Applies `migrations/*.sql` in name order, once each, recording them in schema_migrations. */
export async function migrate(db: Db, now: () => string = () => new Date().toISOString()): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)");
  const applied = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = toDialect(readFileSync(join(MIGRATIONS_DIR, file), "utf8"), db.dialect);
    for (const statement of splitStatements(sql)) {
      try {
        await db.exec(statement);
      } catch (err) {
        if (db.dialect === "mysql" && /^CREATE INDEX/i.test(statement) && isDuplicateIndex(err)) continue;
        throw err;
      }
    }
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, now()]);
    ran.push(file);
  }
  return ran;
}
