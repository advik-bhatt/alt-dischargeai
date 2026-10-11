import { providerLogin, request, jsonBody } from "./api"
export type Role = "doctor" | "caregiver" | "patient"
export type Session = {
  role: Role; displayName: string; subtitle: string; caregiverPatientIds?: string[]
  patientId?: string; patientToken?: string; providerKey?: string; exp: number
}
export const IDLE_TIMEOUT_MS = 15 * 60 * 1000
export const SESSION_STORAGE_KEY = "dai.session"
export const DEMO_DOCTOR = { email: "rivera@demo.health", password: "demo1234" }
export const DEMO_CAREGIVER = { link: "/p/demo-caregiver-456", dob: "2000-01-01" }
export const DEMO_PATIENT_LINK = "/p/demo-token-123"
export const DEMO_PATIENT_DOB = "2000-01-01"
export async function login({ email, password }: { email: string; password: string }): Promise<Session> {
  return { ...await providerLogin(email, password), exp: Date.now() + IDLE_TIMEOUT_MS }
}
export async function resolvePatientToken(token: string, dob: string, role: "patient" | "caregiver" = "patient"): Promise<Session> {
  const result = await request<Omit<Session, "exp">>("/auth/link", jsonBody({ token, dob, role }))
  return { ...result, exp: Date.now() + IDLE_TIMEOUT_MS }
}
export function parsePatientLink(input: string): string {
  const trimmed = input.trim()
  const match = trimmed.match(/\/(?:p|s)\/([^/?#\s]+)/)
  return match ? match[1] : trimmed
}
export function logout(): void { try { sessionStorage.removeItem(SESSION_STORAGE_KEY) } catch { /* unavailable storage */ } }
export function persistSession(session: Session): void {
  try {
    const { providerKey: _key, ...marker } = session
    sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(marker))
  } catch { /* session remains in memory */ }
}
export function restoreSession(): Session | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_STORAGE_KEY) ?? "null") as Session | null
    // Provider secrets stay in memory; a page reload requires provider sign-in again.
    if (!parsed || parsed.exp < Date.now() || parsed.role === "doctor") { logout(); return null }
    return parsed
  } catch { return null }
}
