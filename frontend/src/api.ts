import type { Session } from "./auth"
import type { SummaryResponse } from "./contracts.js"
export type { SummaryResponse } from "./contracts.js"
export type ContractPatient = { ID: string | number; DOB: string | null; FirstName: string | null; LastName: string | null }
export type Accepted = { sumId: string; jobId: string; link: string; expiresAt: string }
export type Job = { stage: string; error: string | null }
export class ApiError extends Error { constructor(public status: number, message: string) { super(message) } }
const BASE_URL = import.meta.env.VITE_API_URL ?? "/api"
export function dictationSocketUrl() {
  const url = new URL(BASE_URL.replace(/\/$/, "") + "/dictation", window.location.href)
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
  return url.toString()
}
export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE_URL + path, init)
  const body = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiError(response.status, body.message ?? body.error ?? `Request failed (${response.status})`)
  return body
}
export const jsonBody = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) })
const provider = (key: string) => ({ "x-provider-key": key })
export async function getPatients(key: string) {
  return (await request<{ patients: ContractPatient[] }>("/patients", { headers: provider(key) })).patients
}
export async function getPatient(id: string, key: string) {
  return request<ContractPatient & { activeLink: { link: string } | null }>(`/patients/${encodeURIComponent(id)}`, { headers: provider(key) })
}
export function postIngest(payload: { data: string; type: "text" | "pdf" | "dictation"; patientId: string; DOB?: string }, key: string) {
  const init = jsonBody({ data: payload.data, type: payload.type === "dictation" ? "text" : payload.type, patientID: payload.patientId, DOB: payload.DOB })
  init.headers = { ...init.headers, ...provider(key) }
  return request<Accepted>("/ingest", init)
}
export function postAudio(audio: Blob, patientId: string, key: string, dob?: string) {
  const form = new FormData()
  form.set("patientId", patientId)
  if (dob) form.set("DOB", dob)
  const extension = audio.type.includes("ogg") ? "ogg" : audio.type.includes("mp4") ? "mp4" : "webm"
  form.set("audio", audio, `dictation.${extension}`)
  return request<Accepted>("/ingest", { method: "POST", headers: provider(key), body: form })
}
export async function waitForJob(jobId: string, key: string) {
  const deadline = Date.now() + 31 * 60_000
  while (Date.now() < deadline) {
    const job = await request<Job>(`/jobs/${encodeURIComponent(jobId)}`, { headers: provider(key) })
    if (job.stage === "failed") throw new Error(job.error ?? "Preparation failed")
    if (["done", "needs_review"].includes(job.stage)) return job
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error("Preparation is still running. Check its status in Swagger.")
}
export const getSummary = (token: string) => request<SummaryResponse>(`/p/${encodeURIComponent(token)}`)
export const getHealth = () => request<{ mode: string; capabilities: { liveAi: boolean; dictation: boolean; translation: boolean; readAloud: boolean } }>('/health')
export const registerPatient = (patient: { ID: string; DOB: string; FirstName?: string; LastName?: string; email?: string; caregiverEmail?: string; preferredLanguage?: string }, key: string) => {
  const init = jsonBody(patient); init.headers = { ...init.headers, ...provider(key) }
  return request<{ patient: ContractPatient; created: boolean }>("/patients", init)
}
export async function getReadAloud(token: string, text: string, language: string, signal: AbortSignal) {
  const response = await fetch(BASE_URL + '/read-aloud', { ...jsonBody({ token, text, language }), signal })
  if (!response.ok) { const body = await response.json(); throw new Error(body.message ?? body.error ?? "Read-aloud failed") }
  return response.blob()
}
export const getTranslation = (token: string, lang: string) => request<SummaryResponse>(`/translation?sum_id=${encodeURIComponent(token)}&lang=${encodeURIComponent(lang)}`)
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error("Could not read the PDF"))
    reader.readAsDataURL(file)
  })
}
export async function providerLogin(email: string, password: string) {
  return request<Omit<Session, "exp">>("/auth/login", jsonBody({ email, password }))
}
