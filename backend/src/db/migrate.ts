import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { splitStatements, type Db, type Dialect } from "./index.js";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/**
 * The migrations are written once, in portable SQL, and rewritten per dialect here:
 *   MySQL/MariaDB: AUTOINCREMENT -> AUTO_INCREMENT; BLOB -> LONGBLOB; TEXT -> MEDIUMTEXT (JSON blobs);
 *                  CREATE INDEX IF NOT EXISTS -> CREATE INDEX (MariaDB accepts IF NOT EXISTS, MySQL 8
 *                  does not; a duplicate index is ignored instead).
 *   SQLite: as written.
 * A file named `NNNN_name.sqlite.sql` or `NNNN_name.mysql.sql` runs only on that dialect, for the few
 * changes the two engines cannot share (rebuilding a table in SQLite, dropping a foreign key in MySQL).
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

/** MySQL 1091: dropping a foreign key that is not there (a database created by the current 0001). */
function isMissingKey(err: unknown): boolean {
  const e = err as { code?: string; errno?: number };
  return e?.code === "ER_CANT_DROP_FIELD_OR_KEY" || e?.errno === 1091;
}

/** `0002_x.sqlite.sql` runs on SQLite only, `0002_x.mysql.sql` on MySQL only, `0001_x.sql` on both. */
export function migrationFilesFor(files: string[], dialect: Dialect): string[] {
  return files
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => {
      const m = /\.(sqlite|mysql)\.sql$/.exec(f);
      return !m || m[1] === dialect;
    })
    .sort();
}

/** Tables the backend's own schema must have (the patients table is the team's and is checked on its own). */
export const REQUIRED_TABLES = ["activeLinks", "jobs", "audit_log", "summaries"] as const;

/** Applies `migrations/*.sql` in name order, once each, recording them in schema_migrations. */
export async function migrate(db: Db, now: () => string = () => new Date().toISOString()): Promise<string[]> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(120) PRIMARY KEY, applied_at VARCHAR(32) NOT NULL)");
  const applied = new Set((await db.all<{ name: string }>("SELECT name FROM schema_migrations")).map((r) => r.name));
  const files = migrationFilesFor(readdirSync(MIGRATIONS_DIR), db.dialect);
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = toDialect(readFileSync(join(MIGRATIONS_DIR, file), "utf8"), db.dialect);
    for (const statement of splitStatements(sql)) {
      try {
        await db.exec(statement);
      } catch (err) {
        if (db.dialect === "mysql" && /^CREATE INDEX/i.test(statement) && isDuplicateIndex(err)) continue;
        if (db.dialect === "mysql" && /DROP FOREIGN KEY/i.test(statement) && isMissingKey(err)) continue;
        throw err;
      }
    }
    await db.run("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)", [file, now()]);
    ran.push(file);
  }
  await assertSchema(db);
  return ran;
}

/**
 * A database created before the team contract (patients with active_link columns, a `links` table
 * keyed by hash) records 0001_init.sql as applied but has none of the contract tables. Say so
 * plainly instead of failing on the first query: the fix is to delete the local SQLite file.
 */
async function assertSchema(db: Db): Promise<void> {
  for (const table of REQUIRED_TABLES) {
    try {
      await db.get(`SELECT 1 FROM ${table} LIMIT 1`);
    } catch {
      throw new Error(
        `SQL schema is out of date: table "${table}" is missing. This database was migrated before the team contract. ` +
          `Delete the local SQLite file (rm backend/data/app.db) or drop the old tables on MariaDB and start again.`,
      );
    }
  }
}
