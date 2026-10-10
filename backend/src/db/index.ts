import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import Database from "better-sqlite3";
import type { Config } from "../config.js";

export type SqlParam = string | number | bigint | Buffer | Uint8Array | null;
export type Dialect = "sqlite" | "mysql";

/**
 * A thin, dialect-neutral SQL adapter. SQL is written with `?` placeholders and portable types;
 * repositories branch on `dialect` only where the two engines really differ (upserts). Everything
 * is async so both drivers share one interface. SQLite is the local and test default; MariaDB on
 * the team's RDS instance (`patients`, port 3306) is the documented production path, over TLS with
 * the public RDS certificate bundle.
 */
export interface Db {
  readonly dialect: Dialect;
  /** Where this connection points, for logs and /health. Never contains the password. */
  readonly describe: string;
  run(sql: string, params?: SqlParam[]): Promise<{ changes: number }>;
  get<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, params?: SqlParam[]): Promise<T[]>;
  /** Runs one or more statements (migrations). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export class SqliteDb implements Db {
  readonly dialect = "sqlite" as const;
  readonly describe: string;
  readonly raw: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
    this.raw = new Database(file);
    this.raw.pragma("journal_mode = WAL");
    this.raw.pragma("foreign_keys = ON");
    this.describe = `sqlite:${file}`;
  }

  async run(sql: string, params: SqlParam[] = []) {
    const info = this.raw.prepare(sql).run(...params);
    return { changes: info.changes };
  }

  async get<T>(sql: string, params: SqlParam[] = []) {
    return this.raw.prepare(sql).get(...params) as T | undefined;
  }

  async all<T>(sql: string, params: SqlParam[] = []) {
    return this.raw.prepare(sql).all(...params) as T[];
  }

  async exec(sql: string) {
    this.raw.exec(sql);
  }

  async close() {
    this.raw.close();
  }
}

export interface MySqlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  /** Path to the RDS CA bundle (AWS connection step 1). Required unless `insecure`: connecting stops when it is missing. */
  caBundlePath?: string;
  connectionLimit?: number;
  /** Skip TLS entirely (a local MariaDB without certificates). Never for RDS. */
  insecure?: boolean;
}

type MySqlPool = import("mysql2/promise").Pool;

/**
 * MariaDB/MySQL adapter over `mysql2/promise` (pooled; `pool.query` with `?` placeholders, so
 * Buffers become hex literals and `LIMIT ?` works). TLS: `ssl: { ca: <global-bundle.pem> }` with
 * server-certificate verification, exactly what the AWS console's `--ssl-verify-server-cert
 * --ssl-ca=./global-bundle.pem` does for the mysql client. The database named by the secret's
 * `mysql-db` is created when missing, then every table is created inside it by the migrations.
 * Loaded lazily so SQLite-only installs never import the driver.
 */
export class MySqlDb implements Db {
  readonly dialect = "mysql" as const;
  readonly describe: string;

  private constructor(
    private readonly pool: MySqlPool,
    opts: MySqlOptions,
    readonly tls: "ca-bundle" | "off",
  ) {
    this.describe = `mysql://${opts.user}@${opts.host}:${opts.port}/${opts.database} (tls=${tls})`;
  }

  static async connect(opts: MySqlOptions): Promise<MySqlDb> {
    const mysql = await import("mysql2/promise");
    let ssl: import("mysql2/promise").PoolOptions["ssl"];
    let tls: MySqlDb["tls"];
    if (opts.insecure) {
      ssl = undefined;
      tls = "off";
    } else {
      ssl = { ca: readCaBundle(opts.caBundlePath), rejectUnauthorized: true };
      tls = "ca-bundle";
    }
    const base = {
      host: opts.host,
      port: opts.port,
      user: opts.user,
      password: opts.password,
      ssl,
      connectTimeout: 10_000,
      charset: "utf8mb4",
      timezone: "Z",
      supportBigNumbers: true,
      decimalNumbers: true,
      // DATE columns (the patients table's DOB) come back as 'YYYY-MM-DD', never shifted by a timezone.
      dateStrings: ["DATE"] as Array<"DATE" | "DATETIME" | "TIMESTAMP">,
    } as const;

    // Make sure the database exists (the secret names it; the tables are created by migrations).
    const admin = await mysql.createConnection(base);
    try {
      await admin.query("CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4", [opts.database]);
    } finally {
      await admin.end();
    }

    const pool = mysql.createPool({
      ...base,
      database: opts.database,
      waitForConnections: true,
      connectionLimit: opts.connectionLimit ?? 5,
      queueLimit: 0,
    });
    return new MySqlDb(pool, opts, tls);
  }

  async run(sql: string, params: SqlParam[] = []) {
    const [r] = await this.pool.query<import("mysql2/promise").ResultSetHeader>(sql, params);
    return { changes: r.affectedRows ?? 0 };
  }

  async get<T>(sql: string, params: SqlParam[] = []) {
    const [rows] = await this.pool.query<import("mysql2/promise").RowDataPacket[]>(sql, params);
    return rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: SqlParam[] = []) {
    const [rows] = await this.pool.query<import("mysql2/promise").RowDataPacket[]>(sql, params);
    return rows as T[];
  }

  async exec(sql: string) {
    for (const statement of splitStatements(sql)) {
      await this.pool.query(statement);
    }
  }

  async close() {
    await this.pool.end();
  }
}

/** Splits a migration file into statements: comments removed, split on `;` at end of statement. */
export function splitStatements(sql: string): string[] {
  const noComments = sql
    .split(/\r?\n/)
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n");
  return noComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface ParsedDatabaseUrl {
  dialect: Dialect;
  file?: string;
  mysql?: Omit<MySqlOptions, "caBundlePath" | "connectionLimit">;
}

/**
 * `sqlite:<file>` | `sqlite::memory:` | `mysql://user:password@host:3306/database[?insecure=1]`.
 * The password is URL-decoded, so the RDS password's punctuation survives when it is percent-encoded.
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  const trimmed = url.trim();
  if (/^sqlite:/i.test(trimmed)) {
    const file = trimmed.replace(/^sqlite:(\/\/)?/i, "") || ":memory:";
    return { dialect: "sqlite", file };
  }
  if (/^(mysql|mariadb):\/\//i.test(trimmed)) {
    const u = new URL(trimmed.replace(/^mariadb:/i, "mysql:"));
    const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
    if (!database) throw new Error("DATABASE_URL must name a database: mysql://user:password@host:3306/dischargeai");
    return {
      dialect: "mysql",
      mysql: {
        host: u.hostname,
        port: u.port ? Number(u.port) : 3306,
        user: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
        database,
        insecure: ["1", "true"].includes(u.searchParams.get("insecure") ?? ""),
      },
    };
  }
  throw new Error("DATABASE_URL must start with sqlite: or mysql://");
}

/** Where the backend lives (backend/), so relative paths in the config do not depend on the shell's directory. */
export const BACKEND_DIR = resolve(import.meta.dirname, "..", "..");

/** RDS_CA_BUNDLE as an absolute path: relative values are read from backend/, wherever the process was started. */
export function resolveCaBundlePath(configured: string): string {
  return isAbsolute(configured) ? configured : resolve(BACKEND_DIR, configured);
}

/**
 * AWS connection step 1's `global-bundle.pem`, passed to mysql2 as `ssl.ca` (the equivalent of the
 * console's `--ssl-verify-server-cert --ssl-ca=./global-bundle.pem`). A missing or empty bundle stops
 * the connection with the command that fetches it, instead of quietly trusting something else.
 */
export function readCaBundle(path: string | undefined): Buffer {
  const fetch = "npm run fetch-rds-bundle (runs: curl -o global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem into backend/certs/)";
  if (!path || !existsSync(path)) throw new Error(`RDS CA bundle not found at ${path ?? "(unset)"}. Fetch it with ${fetch}, or point RDS_CA_BUNDLE at it.`);
  const pem = readFileSync(path);
  if (!pem.toString("utf8").includes("BEGIN CERTIFICATE")) throw new Error(`RDS CA bundle at ${path} holds no certificates. Fetch it again with ${fetch}.`);
  return pem;
}

/**
 * Resolution order: DATABASE_URL -> MYSQL_HOST (set by the Secrets Manager bootstrap or by hand) ->
 * SQLite file. With no AWS access the app therefore runs fully local.
 */
export async function openDb(
  config: Pick<Config, "DATABASE_URL" | "DATABASE_FILE" | "MYSQL_HOST" | "MYSQL_PORT" | "MYSQL_USER" | "MYSQL_PASSWORD" | "MYSQL_DATABASE" | "RDS_CA_BUNDLE" | "MYSQL_POOL_SIZE">,
): Promise<Db> {
  const caBundlePath = resolveCaBundlePath(config.RDS_CA_BUNDLE);
  if (config.DATABASE_URL) {
    const parsed = parseDatabaseUrl(config.DATABASE_URL);
    if (parsed.dialect === "sqlite") return new SqliteDb(parsed.file!);
    return MySqlDb.connect({ ...parsed.mysql!, caBundlePath, connectionLimit: config.MYSQL_POOL_SIZE });
  }
  if (config.MYSQL_HOST) {
    if (!config.MYSQL_USER || !config.MYSQL_PASSWORD) throw new Error("MYSQL_HOST is set but MYSQL_USER / MYSQL_PASSWORD are missing (they come from Secrets Manager or the environment)");
    return MySqlDb.connect({
      host: config.MYSQL_HOST,
      port: config.MYSQL_PORT,
      user: config.MYSQL_USER,
      password: config.MYSQL_PASSWORD,
      database: config.MYSQL_DATABASE,
      caBundlePath,
      connectionLimit: config.MYSQL_POOL_SIZE,
    });
  }
  return new SqliteDb(config.DATABASE_FILE);
}
