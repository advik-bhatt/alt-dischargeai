import type { Db, SqlParam } from "../index.js";

/**
 * Patients come from the team's own table, `patientinfo` in the `dischargeai` database on RDS (the
 * same table the infra branch's server reads with `SELECT * FROM patientinfo`). This backend never
 * creates patients there and never seeds it.
 *
 * Nobody has published that table's column names, so they are discovered at startup and matched by
 * name, ignoring case and underscores: `FirstName`, `first_name` and `firstname` all map to the first
 * name. The tasks doc's own spellings (ID, DOB, FirstName, LastName, ZipCode, email, phoneNumber,
 * caregiverEmail, caregiverName) are the expected ones. Startup fails with the actual column list when
 * no id column is found, rather than serving the wrong data. PATIENTS_TABLE names another table.
 */

/** A patient as the backend uses it internally (ingest, email, the active link). */
export interface Patient {
  /** The id as text, for joins (activeLinks.patientID is VARCHAR). */
  id: string;
  /** The id exactly as the table holds it (a number when the column is INT), for GET /patients. */
  idValue: string | number;
  firstName: string | null;
  lastName: string | null;
  dateOfBirth: string | null;
  zipCode: string | null;
  email: string | null;
  phone: string | null;
  caregiverEmail: string | null;
  caregiverName: string | null;
  /** Only when the table has such a column; otherwise ingest defaults to English. */
  preferredLanguage: string | null;
}

/** The synthetic patients that `npm run seed` writes into a local SQLite table (never MySQL). */
export interface NewPatient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  zipCode: string;
  email: string;
  phone: string;
  caregiverEmail?: string | null;
  caregiverName?: string | null;
  preferredLanguage?: string | null;
}

/** The team contract's GET /patients item: exactly these nine keys, these spellings. */
export interface ContractPatient {
  ID: string | number;
  DOB: string | null;
  FirstName: string | null;
  LastName: string | null;
  ZipCode: string | null;
  email: string | null;
  phoneNumber: string | null;
  caregiverEmail: string | null;
  caregiverName: string | null;
}

export const CONTRACT_PATIENT_KEYS = ["ID", "DOB", "FirstName", "LastName", "ZipCode", "email", "phoneNumber", "caregiverEmail", "caregiverName"] as const;

type Field = "id" | "dateOfBirth" | "firstName" | "lastName" | "zipCode" | "email" | "phone" | "caregiverEmail" | "caregiverName" | "preferredLanguage";

/** Accepted column names per field, compared after lower-casing and dropping everything but letters and digits. */
const ALIASES: Record<Field, string[]> = {
  id: ["id", "patientid", "uid", "patientuid"],
  dateOfBirth: ["dob", "dateofbirth", "birthdate", "birthday"],
  firstName: ["firstname", "fname", "givenname"],
  lastName: ["lastname", "lname", "surname", "familyname"],
  zipCode: ["zipcode", "zip", "postalcode", "postcode"],
  email: ["email", "emailaddress", "patientemail"],
  phone: ["phonenumber", "phone", "phoneno", "mobile", "mobilenumber", "cellphone"],
  caregiverEmail: ["caregiveremail"],
  caregiverName: ["caregivername"],
  preferredLanguage: ["preferredlanguage", "language", "lang"],
};

const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
const quote = (identifier: string) => `\`${identifier.replace(/`/g, "``")}\``;

export type ColumnMap = Partial<Record<Field, string>>;

/** Maps the table's real columns to the fields above. Exported for tests. */
export function mapColumns(columns: string[]): ColumnMap {
  const map: ColumnMap = {};
  for (const field of Object.keys(ALIASES) as Field[]) {
    // Alias order is priority: a table with both `ID` and `uid` uses ID.
    for (const alias of ALIASES[field]) {
      const hit = columns.find((c) => normalize(c) === alias);
      if (hit) {
        map[field] = hit;
        break;
      }
    }
  }
  return map;
}

function text(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/** DATE columns arrive as 'YYYY-MM-DD' (dateStrings) or, from other drivers, as a Date at UTC midnight. */
function dateOnly(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  return String(v);
}

export function toContractPatient(p: Patient): ContractPatient {
  return {
    ID: p.idValue,
    DOB: p.dateOfBirth,
    FirstName: p.firstName,
    LastName: p.lastName,
    ZipCode: p.zipCode,
    email: p.email,
    phoneNumber: p.phone,
    caregiverEmail: p.caregiverEmail,
    caregiverName: p.caregiverName,
  };
}

export class PatientsRepo {
  private map: ColumnMap | undefined;
  private columns: string[] = [];

  constructor(
    private readonly db: Db,
    readonly table: string = "patientinfo",
  ) {
    if (!/^[A-Za-z0-9_]+$/.test(table)) throw new Error(`PATIENTS_TABLE must be a plain table name (letters, digits, underscores), got "${table}"`);
  }

  get dialect() {
    return this.db.dialect;
  }

  /** Reads the table's columns and maps them. Throws with the real column list when there is no id column. */
  async init(): Promise<{ table: string; columns: string[]; mapped: ColumnMap; unmapped: string[] }> {
    this.columns = await this.readColumns();
    if (!this.columns.length) {
      throw new Error(`Patients table "${this.table}" was not found in ${this.db.describe}. Set PATIENTS_TABLE if the team's table has another name.`);
    }
    const map = mapColumns(this.columns);
    if (!map.id) {
      throw new Error(`Patients table "${this.table}" has no id column the backend recognises (expected ID, patientID or uid). Its columns: ${this.columns.join(", ")}`);
    }
    this.map = map;
    const unmapped = CONTRACT_PATIENT_KEYS.filter((k) => !map[contractField(k)]);
    return { table: this.table, columns: this.columns, mapped: map, unmapped };
  }

  private async readColumns(): Promise<string[]> {
    if (this.db.dialect === "sqlite") {
      const rows = await this.db.all<{ name: string }>(`PRAGMA table_info(${quote(this.table)})`);
      return rows.map((r) => r.name);
    }
    const rows = await this.db.all<{ name: string }>(
      "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION",
      [this.table],
    );
    return rows.map((r) => r.name);
  }

  private async columnMap(): Promise<ColumnMap> {
    if (!this.map) await this.init();
    return this.map!;
  }

  private toPatient(row: Record<string, unknown>, map: ColumnMap): Patient {
    const get = (f: Field) => (map[f] ? row[map[f]!] : undefined);
    const rawId = get("id");
    return {
      id: String(rawId),
      idValue: typeof rawId === "number" ? rawId : String(rawId),
      firstName: text(get("firstName")),
      lastName: text(get("lastName")),
      dateOfBirth: dateOnly(get("dateOfBirth")),
      zipCode: text(get("zipCode")),
      email: text(get("email")),
      phone: text(get("phone")),
      caregiverEmail: text(get("caregiverEmail")) || null,
      caregiverName: text(get("caregiverName")) || null,
      preferredLanguage: text(get("preferredLanguage")) || null,
    };
  }

  /** Every row of the table, optionally filtered by a case-insensitive substring of name, email or phone; sorted by last then first name. */
  async list(q?: string): Promise<Patient[]> {
    const map = await this.columnMap();
    const rows = await this.db.all<Record<string, unknown>>(`SELECT * FROM ${quote(this.table)}`);
    let patients = rows.map((r) => this.toPatient(r, map));
    const needle = q?.trim().toLowerCase();
    if (needle) {
      patients = patients.filter((p) =>
        [p.firstName, p.lastName, `${p.firstName ?? ""} ${p.lastName ?? ""}`, p.email, p.phone].some((v) => v && v.toLowerCase().includes(needle)),
      );
    }
    const key = (p: Patient) => `${(p.lastName ?? "").toLowerCase()}\u0000${(p.firstName ?? "").toLowerCase()}`;
    return patients.sort((a, b) => key(a).localeCompare(key(b)));
  }

  async getById(id: string): Promise<Patient | undefined> {
    const map = await this.columnMap();
    const row = await this.db.get<Record<string, unknown>>(`SELECT * FROM ${quote(this.table)} WHERE ${quote(map.id!)} = ? LIMIT 1`, [id]);
    return row ? this.toPatient(row, map) : undefined;
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number | string }>(`SELECT COUNT(*) AS n FROM ${quote(this.table)}`);
    return Number(row?.n ?? 0);
  }

  /**
   * Local SQLite only (`npm run seed`, tests): inserts one synthetic patient into the mapped columns.
   * Refuses on MySQL, where the table is the team's real patient list.
   */
  async insertLocal(p: NewPatient): Promise<void> {
    if (this.db.dialect !== "sqlite") throw new Error(`Refusing to write synthetic patients into ${this.db.describe}: "${this.table}" there is the team's real patient table. Seeding is for local SQLite only.`);
    const map = await this.columnMap();
    const values: Partial<Record<Field, SqlParam>> = {
      id: p.id,
      firstName: p.firstName,
      lastName: p.lastName,
      dateOfBirth: p.dateOfBirth,
      zipCode: p.zipCode,
      email: p.email,
      phone: p.phone,
      caregiverEmail: p.caregiverEmail ?? null,
      caregiverName: p.caregiverName ?? null,
      preferredLanguage: p.preferredLanguage ?? null,
    };
    const fields = (Object.keys(values) as Field[]).filter((f) => map[f]);
    await this.db.run(
      `INSERT INTO ${quote(this.table)} (${fields.map((f) => quote(map[f]!)).join(", ")}) VALUES (${fields.map(() => "?").join(", ")})`,
      fields.map((f) => values[f] ?? null),
    );
  }
}

function contractField(key: (typeof CONTRACT_PATIENT_KEYS)[number]): Field {
  const byKey: Record<(typeof CONTRACT_PATIENT_KEYS)[number], Field> = {
    ID: "id",
    DOB: "dateOfBirth",
    FirstName: "firstName",
    LastName: "lastName",
    ZipCode: "zipCode",
    email: "email",
    phoneNumber: "phone",
    caregiverEmail: "caregiverEmail",
    caregiverName: "caregiverName",
  };
  return byKey[key];
}
