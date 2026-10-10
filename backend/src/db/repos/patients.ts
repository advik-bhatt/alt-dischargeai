import { randomUUID } from "node:crypto";
import type { Db } from "../index.js";

export interface PatientRow {
  id: string;
  first_name: string;
  last_name: string;
  date_of_birth: string;
  zip_code: string;
  email: string;
  phone: string;
  caregiver_email: string | null;
  caregiver_name: string | null;
  preferred_language: string | null;
  created_at: string;
}

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: string;
  zipCode: string;
  email: string;
  phone: string;
  caregiverEmail: string | null;
  caregiverName: string | null;
  preferredLanguage: string | null;
  createdAt: string;
}

export interface NewPatient {
  id?: string;
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
  ID: string;
  DOB: string;
  FirstName: string;
  LastName: string;
  ZipCode: string;
  email: string;
  phoneNumber: string;
  caregiverEmail: string | null;
  caregiverName: string | null;
}

export const CONTRACT_PATIENT_KEYS = ["ID", "DOB", "FirstName", "LastName", "ZipCode", "email", "phoneNumber", "caregiverEmail", "caregiverName"] as const;

export function toPatient(r: PatientRow): Patient {
  return {
    id: r.id,
    firstName: r.first_name,
    lastName: r.last_name,
    dateOfBirth: r.date_of_birth,
    zipCode: r.zip_code,
    email: r.email,
    phone: r.phone,
    caregiverEmail: r.caregiver_email,
    caregiverName: r.caregiver_name,
    preferredLanguage: r.preferred_language,
    createdAt: r.created_at,
  };
}

export function toContractPatient(p: Patient): ContractPatient {
  return {
    ID: p.id,
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
  constructor(private readonly db: Db) {}

  async list(q?: string): Promise<Patient[]> {
    if (q && q.trim()) {
      const like = `%${q.trim().toLowerCase()}%`;
      const rows = await this.db.all<PatientRow>(
        `SELECT * FROM patients
         WHERE LOWER(first_name) LIKE ? OR LOWER(last_name) LIKE ? OR LOWER(email) LIKE ? OR phone LIKE ?
            OR LOWER(CONCAT(first_name, ' ', last_name)) LIKE ?
         ORDER BY last_name, first_name`,
        [like, like, like, like, like],
      );
      return rows.map(toPatient);
    }
    const rows = await this.db.all<PatientRow>("SELECT * FROM patients ORDER BY last_name, first_name");
    return rows.map(toPatient);
  }

  async getById(id: string): Promise<Patient | undefined> {
    const row = await this.db.get<PatientRow>("SELECT * FROM patients WHERE id = ?", [id]);
    return row ? toPatient(row) : undefined;
  }

  async count(): Promise<number> {
    const row = await this.db.get<{ n: number | string }>("SELECT COUNT(*) AS n FROM patients");
    return Number(row?.n ?? 0);
  }

  async create(p: NewPatient, createdAt: string): Promise<Patient> {
    const id = p.id ?? randomUUID();
    await this.db.run(
      `INSERT INTO patients (id, first_name, last_name, date_of_birth, zip_code, email, phone, caregiver_email, caregiver_name, preferred_language, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, p.firstName, p.lastName, p.dateOfBirth, p.zipCode, p.email, p.phone, p.caregiverEmail ?? null, p.caregiverName ?? null, p.preferredLanguage ?? null, createdAt],
    );
    return (await this.getById(id))!;
  }
}
