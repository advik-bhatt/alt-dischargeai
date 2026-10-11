import { useEffect, useRef, useState } from "react"
import { Icon, BrandMark } from "./ui"
import { type Session } from "./auth"
import { useLiveDictation } from "./useLiveDictation"
import { extractPdfText } from "./extractPdfText"
import { postIngest, getPatients, getPatient, waitForJob, fileToBase64, getHealth, registerPatient, type Accepted } from "./api"

type Patient = {
  id: string
  dob?: string
  name: string
  initials: string
  age: number | null
  mrn: string
  visit: string
  status: string
  physician: string
  admittedDate: string
  tags: string[]
}

const emptyPatient: Patient = { id: "", name: "Loading patients…", initials: "…", age: null, mrn: "—", visit: "Discharge writeup", status: "Not sent", physician: "—", admittedDate: "—", tags: [] }

function statusClass(status: string) {
  if (status === "Ready") return "status-pill status-ready"
  if (status === "In progress") return "status-pill status-progress"
  return "status-pill status-draft"
}

type Stat = { label: string; value: string; hint: string; highlight?: boolean }


type ChecklistItem = { id: string; label: string; done: boolean }

const initialChecklist: ChecklistItem[] = [
  { id: "c1", label: "Medication reconciliation", done: false },
  { id: "c2", label: "Follow-up appointment scheduled", done: false },
  { id: "c3", label: "Patient education provided", done: false },
  { id: "c4", label: "Prescriptions sent", done: false },
  { id: "c5", label: "Transportation arranged", done: false },
]

type TeamMember = { initials: string; name: string; role: string }

const careTeam: TeamMember[] = []

type ActivityEntry = { description: string; time: string }



function PatientNavItem({
  patient,
  active,
  onSelect,
}: {
  patient: Patient
  active: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={`nav-item patient-nav-item ${active ? "nav-item-active" : ""}`}
      onClick={onSelect}
      type="button"
    >
      <span className="nav-patient-avatar">{patient.initials}</span>
      <span className="nav-patient-name">{patient.name}</span>
    </button>
  )
}

function initialsFrom(name: string) {
  const words = name.replace(/^dr\.?\s+/i, "").split(/\s+/).filter(Boolean)
  const letters = words.map((w) => w[0]).join("")
  return (letters.slice(0, 2) || "DR").toUpperCase()
}

// Per-patient note store
type PatientNote = { text: string; inputType: "text" | "pdf"; pdfData?: string }
const emptyNote = (): PatientNote => ({ text: "", inputType: "text" })

export function DoctorDashboard({
  session,
  onLogout,
}: {
  session: Session
  onLogout: () => void
}) {
  // Map of patientId -> note so switching patients preserves each writeup
  const [notes, setNotes] = useState<Record<string, PatientNote>>({})
  const [patients, setPatients] = useState<Patient[]>([])
  const [selectedPatientId, setSelectedPatientId] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [loadError, setLoadError] = useState<string>()
  const [results, setResults] = useState<Record<string, Accepted>>({})
  const [sendMessage, setSendMessage] = useState<string>()
  const [sendError, setSendError] = useState<string>()
  const [activity, setActivity] = useState<ActivityEntry[]>([])
  const [environment, setEnvironment] = useState<Awaited<ReturnType<typeof getHealth>>>()
  const [registering, setRegistering] = useState(false)
  const [registration, setRegistration] = useState({ ID: "", DOB: "", FirstName: "", LastName: "", email: "", caregiverEmail: "" })
  const [registrationError, setRegistrationError] = useState<string>()
  const [savingPatient, setSavingPatient] = useState(false)
  const handleRegister = async (event: React.FormEvent) => {
    event.preventDefault(); setSavingPatient(true); setRegistrationError(undefined)
    try {
      const result = await registerPatient({ ...registration, email: registration.email || undefined, caregiverEmail: registration.caregiverEmail || undefined }, session.providerKey ?? "")
      const row = result.patient
      const name = [row.FirstName, row.LastName].filter(Boolean).join(" ") || String(row.ID)
      const patient = { ...emptyPatient, id: String(row.ID), dob: row.DOB ?? undefined, name, initials: initialsFrom(name), physician: session.displayName }
      clearRecording(); setPatients(prev => [...prev.filter(p => p.id !== patient.id), patient]); setSelectedPatientId(patient.id)
      setSendMessage(result.created ? "Patient registered. Add a visit writeup below." : "Patient matched. New notes append to the active plan within 30 days.")
      setRegistering(false)
    } catch (err) { setRegistrationError(err instanceof Error ? err.message : "Could not register patient") }
    finally { setSavingPatient(false) }
  }
  useEffect(() => {
    let active = true
    getHealth().then(value => { if (active) setEnvironment(value) }).catch(err => { if (active) setLoadError(err.message) })
    getPatients(session.providerKey ?? "").then(rows => {
      if (!active) return
      const mapped = rows.map(row => {
        const name = [row.FirstName, row.LastName].filter(Boolean).join(" ") || String(row.ID)
        const birth = row.DOB ? new Date(row.DOB) : undefined
        const now = new Date()
        const age = birth ? now.getFullYear() - birth.getFullYear() - (now.getMonth() < birth.getMonth() || (now.getMonth() === birth.getMonth() && now.getDate() < birth.getDate()) ? 1 : 0) : null
        return { ...emptyPatient, id: String(row.ID), dob: row.DOB ?? undefined, name, initials: initialsFrom(name), age, physician: session.displayName }
      })
      setPatients(mapped); setSelectedPatientId(mapped[0]?.id ?? "")
    }).catch(err => { if (active) setLoadError(err.message) })
    return () => { active = false }
  }, [session.providerKey, session.displayName])
  const stats: Stat[] = [
    { label: "Pending discharges", value: "—", hint: "Not reported by the API" },
    { label: "Drafts in review", value: "—", hint: "Not reported by the API" },
    { label: "Sent today", value: String(activity.length), hint: "This browser session" },
    { label: "Avg. completion time", value: "—", hint: "Not reported by the API" },
  ]
  const [seconds, setSeconds] = useState(0)
  const [sending, setSending] = useState(false)
  const [checklists, setChecklists] = useState<Record<string, ChecklistItem[]>>({})
  const checklist = checklists[selectedPatientId] ?? initialChecklist
  const [pdfLoading, setPdfLoading] = useState(false)
  const [pdfError, setPdfError] = useState<string | null>(null)

  const dictationDraft = useRef({ patientId: "", prefix: "" })
  const { status: dictationStatus, isRecording, isBusy: dictationBusy, error: transcribeError, start: startRecording, stop: stopRecording, clear: clearRecording } = useLiveDictation(session.providerKey ?? "", text => {
    const { patientId, prefix } = dictationDraft.current
    setNotes(prev => ({ ...prev, [patientId]: { text: prefix + text, inputType: "text" } }))
  })

  const currentNote = notes[selectedPatientId] ?? emptyNote()
  const noteText = currentNote.text
  const handleStartDictation = () => {
    if (!selectedPatientId || dictationBusy) return
    dictationDraft.current = { patientId: selectedPatientId, prefix: noteText ? noteText.trimEnd() + "\n\n" : "" }
    setSendError(undefined); setSendMessage(undefined)
    void startRecording()
  }

  const setNoteText = (text: string, inputType?: PatientNote["inputType"]) => {
    clearRecording(); setSendMessage(undefined); setSendError(undefined)
    setNotes((prev) => ({
      ...prev,
      [selectedPatientId]: {
        text,
        inputType: inputType ?? "text",
      },
    }))
  }

  // Switch patient — stop any active recording first
  const handleSelectPatient = (id: string) => {
    if (sending || pdfLoading) return
    clearRecording(); setSendMessage(undefined); setSendError(undefined)
    setPdfError(null)
    setSelectedPatientId(id)
  }

  const selectedPatient =
    patients.find((p) => p.id === selectedPatientId) ?? emptyPatient

  // Filter the sidebar patient list by the top-bar search (name, MRN or patient ID)
  const query = searchQuery.trim().toLowerCase()
  const filteredPatients = query
    ? patients.filter(
        (p) =>
          p.name.toLowerCase().includes(query) ||
          p.mrn.toLowerCase().includes(query) ||
          p.id.toLowerCase().includes(query)
      )
    : patients

  const completedCount = checklist.filter((item) => item.done).length
  const checklistProgress = Math.round((completedCount / checklist.length) * 100)

  const toggleChecklistItem = (id: string) => {
    setChecklists(prev => ({ ...prev, [selectedPatientId]: (prev[selectedPatientId] ?? initialChecklist)
      .map(item => item.id === id ? { ...item, done: !item.done } : item) }))
  }

  useEffect(() => {
    if (!isRecording) { setSeconds(0); return }
    const timer = window.setInterval(() => setSeconds((v) => v + 1), 1000)
    return () => window.clearInterval(timer)
  }, [isRecording])

  const formattedTime = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`

  // PDF upload — extracts text and inserts it into the unified textarea
  const handlePdfFile = async (file: File) => {
    const patientId = selectedPatientId
    clearRecording(); setSendMessage(undefined); setSendError(undefined)
    setPdfError(null)
    setPdfLoading(true)
    try {
      const result = await extractPdfText(file)
      if (!result.ok) { setPdfError(result.message); return }
      const pdfData = await fileToBase64(file)
      setNotes(prev => {
        const cur = prev[patientId] ?? emptyNote()
        const joined = cur.text ? cur.text + "\n\n" + result.text : result.text
        return { ...prev, [patientId]: { text: joined, inputType: cur.text ? "text" : "pdf", ...(cur.text ? {} : { pdfData }) } }
      })
    } catch (err) { setPdfError(err instanceof Error ? err.message : "Could not read the PDF") }
    finally { setPdfLoading(false) }
  }

  const handleDownload = () => {
    if (!noteText) return
    const blob = new Blob([noteText], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `writeup-${selectedPatientId}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const handleSend = async () => {
    if (!noteText.trim() || sending || !selectedPatient.id || dictationBusy || pdfLoading) return
    setSending(true); setSendError(undefined); setSendMessage("Preparing your plan…")
    try {
      const key = session.providerKey ?? ""
      const accepted = await postIngest({ data: currentNote.pdfData ?? noteText, type: currentNote.pdfData ? "pdf" : "text", patientId: selectedPatient.id, DOB: selectedPatient.dob }, key)
      await waitForJob(accepted.jobId, key)
      setResults(prev => ({ ...prev, [selectedPatient.id]: accepted }))
      setSendMessage("Plan ready. Open the patient link below.")
      setPatients(prev => prev.map(p => p.id === selectedPatient.id ? { ...p, status: "Ready" } : p))
      setActivity(prev => [{ description: "Writeup processed", time: "Just now" }, ...prev])
    } catch (err) {
      setSendMessage(undefined)
      setSendError(err instanceof Error ? err.message : "Could not prepare the plan")
    } finally { setSending(false) }
  }
  const handleViewPatient = async () => {
    try {
      const detail = await getPatient(selectedPatientId, session.providerKey ?? "")
      if (detail.activeLink) window.open(detail.activeLink.link, "_blank", "noopener,noreferrer")
      else setSendError("Send a writeup first to create a patient plan.")
    } catch (err) { setSendError(err instanceof Error ? err.message : "Could not open the plan") }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <div className="brand">
            <div className="brand-mark">
              <BrandMark size={28} />
            </div>
            <span>Discharge AI</span>
          </div>

          <nav aria-label="Patient list" className="main-nav">
            <div className="nav-section-label">
              <Icon name="patients" size={16} />
              <span>Patients</span>
            </div>
            {filteredPatients.length > 0 || !query ? (
              filteredPatients.map((patient) => (
                <PatientNavItem
                  active={patient.id === selectedPatientId}
                  key={patient.id}
                  onSelect={() => handleSelectPatient(patient.id)}
                  patient={patient}
                />
              ))
            ) : (
              <p className="nav-empty">No patients match "{searchQuery.trim()}"</p>
            )}
          </nav>
        </div>

        <div className="sidebar-bottom">
          <div className="profile">
            <div className="avatar">{initialsFrom(session.displayName)}</div>
            <div className="profile-copy">
              <strong>{session.displayName}</strong>
              <span>{session.subtitle}</span>
            </div>
            <Icon name="chevron" size={16} />
          </div>
          <button className="logout-button" onClick={onLogout} type="button">
            <Icon name="logout" size={16} />
            Sign out
          </button>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="mobile-brand">
            <div className="brand-mark brand-mark-mobile">
              <BrandMark size={24} />
            </div>
            <span>Discharge AI</span>
          </div>
          <label className="search">
            <Icon name="search" size={18} />
            <input
              aria-label="Search patients"
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search patients"
              type="search"
              value={searchQuery}
            />
          </label>
          <button aria-label="Notifications" className="icon-button" type="button">
            <Icon name="bell" size={19} />
            <span className="notification-dot" />
          </button>
        </header>

        <div className="workspace">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Patient communication</p>
              <h1>Create visit writeup</h1>
              <p className="heading-support">
                Summarize the visit and send clear next steps to the right people.
              </p>
            </div>
            <button className="secondary-button" type="button" onClick={() => setRegistering(value => !value)} disabled={sending || savingPatient || dictationBusy}>
              <Icon name="clock" size={17} />
              Register patient
            </button>
          </div>

          {registering && <form className="composer-card" onSubmit={handleRegister} aria-label="Register patient">
            <h2>Register or find a patient</h2>
            {([['ID', 'Patient ID', 'text'], ['DOB', 'Date of birth', 'date'], ['FirstName', 'First name', 'text'], ['LastName', 'Last name', 'text'], ['email', 'Patient email', 'email'], ['caregiverEmail', 'Caregiver email', 'email']] as const).map(([key, label, type]) =>
              <div className="field" key={key}><label htmlFor={`register-${key}`}>{label}</label><input id={`register-${key}`} type={type} required={key === 'ID' || key === 'DOB'} value={registration[key]} onChange={event => setRegistration(prev => ({ ...prev, [key]: event.target.value }))} /></div>)}
            {registrationError && <p className="auth-notice" role="alert">{registrationError}</p>}
            <button className="primary-button" type="submit" disabled={savingPatient}>{savingPatient ? 'Saving…' : 'Save patient'}</button>
          </form>}
          <section className="stat-row" aria-label="Workspace summary">
            {stats.map((stat) => (
              <div
                className={`stat-card ${stat.highlight ? "stat-card-highlight" : ""}`}
                key={stat.label}
              >
                <span className="stat-value">{stat.value}</span>
                <span className="stat-label">{stat.label}</span>
                <span className="stat-hint">
                  <Icon name="activity" size={13} />
                  {stat.hint}
                </span>
              </div>
            ))}
          </section>

          <section className="patient-card" aria-label="Selected patient">
            <div className="patient-avatar">{selectedPatient.initials}</div>
            <div className="patient-info">
              <div className="patient-name-row">
                <h2>{selectedPatient.name}</h2>
                <span className={statusClass(selectedPatient.status)}>
                  {selectedPatient.status}
                </span>
              </div>
              <div className="patient-meta">
                <span>{selectedPatient.age === null ? "Age unavailable" : `${selectedPatient.age} years`}</span>
                <i />
                <span>ID {selectedPatient.id || "—"}</span>
                <i />
                <span>{selectedPatient.visit}</span>
              </div>
              <div className="patient-detail-row">
                <span className="patient-detail">
                  <Icon name="stethoscope" size={14} />
                  {selectedPatient.physician}
                </span>
                <span className="patient-detail">
                  <Icon name="calendar" size={14} />
                  {selectedPatient.admittedDate}
                </span>
              </div>
              <div className="patient-tags">
                {selectedPatient.tags.map((tag) => (
                  <span className="patient-tag" key={tag}>{tag}</span>
                ))}
              </div>
            </div>
            <button className="patient-link" onClick={handleViewPatient} type="button">
              View patient
              <Icon name="chevron" size={15} />
            </button>
          </section>

          <div className="content-grid">
            <section className="composer-card">
              <div className="composer-top">
                <span className="composer-title">
                  <Icon name="document" size={16} />
                  Visit writeup
                </span>
                <span className="autosave">
                  {sending ? "Preparing…" : "Draft in this session"}
                </span>
              </div>

              <div className="write-panel">
                <div className="textarea-wrap">
                  <textarea
                    id="visit-summary"
                    disabled={sending || pdfLoading}
                    readOnly={dictationBusy}
                    aria-label="Visit writeup"
                    className={isRecording ? "is-recording-textarea" : ""}
                    onChange={(e) => setNoteText(e.target.value)}
                    placeholder="Write a summary, dictate using the mic, or upload a PDF using the attach button…"
                    value={noteText}
                  />

                  {/* Mic button — top right */}
                  <button
                    aria-label={isRecording ? "Stop dictation" : "Start dictation"}
                    disabled={sending || pdfLoading || !selectedPatientId || (dictationBusy && !isRecording) || environment?.capabilities.dictation === false}
                    className={`mic-button ${isRecording ? "mic-active" : ""}`}
                    onClick={isRecording ? stopRecording : handleStartDictation}
                    title={environment?.capabilities.dictation === false ? "Paste text or upload a PDF; live dictation is not configured" : isRecording ? "Stop dictation" : "Dictate into note"}
                    type="button"
                  >
                    <Icon name={isRecording ? "stop" : "microphone"} size={22} />
                  </button>

                  {/* PDF upload button — below mic */}
                  <label
                    aria-label="Upload PDF"
                    className={`pdf-attach-button ${pdfLoading ? "pdf-attach-loading" : ""}`}
                    title="Upload a PDF — text will be inserted into the note"
                  >
                    <Icon name={pdfLoading ? "clock" : "upload"} size={18} />
                    <input
                      accept="application/pdf"
                      disabled={sending || pdfLoading || dictationBusy || !selectedPatientId}
                      hidden
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) handlePdfFile(f) }}
                      type="file"
                    />
                  </label>
                </div>

                {pdfError && <p className="transcript-error">⚠ {pdfError}</p>}
                {transcribeError && <p className="transcript-error" role="alert">{transcribeError}</p>}

                <div className="editor-footer">
                  <span>{noteText.length} characters</span>
                  <span>
                    {dictationBusy ? (
                      <span className="recording-indicator">
                        <span className="recording-dot" aria-hidden="true" />
                        {dictationStatus === "connecting" ? "Connecting microphone…" : dictationStatus === "finishing" ? "Finishing transcription…" : `Listening… ${formattedTime}`}
                      </span>
                    ) : (
                      "Last edit just now"
                    )}
                  </span>
                </div>
              </div>

              {environment?.mode === "local-agentcore" && <p className="heading-support" role="status">Live AI · local storage · test emails captured locally. {environment.capabilities.dictation ? "Use text, PDF or live dictation. Dictation appears as you speak; stop to review and edit it before sending." : "Use text or PDF."}</p>}
              {loadError && <p className="transcript-error" role="alert">{loadError}</p>}
              {sendError && <p className="transcript-error" role="alert">{sendError}</p>}
              {sendMessage && <p className="heading-support" role="status">{sendMessage}</p>}
              {results[selectedPatientId] && <a className="patient-link" href={results[selectedPatientId].link} target="_blank" rel="noreferrer">Open patient plan</a>}
              <div className="composer-actions">
                <button
                  className="secondary-button"
                  disabled={!noteText}
                  onClick={handleDownload}
                  type="button"
                >
                  <Icon name="download" size={16} />
                  Download .txt
                </button>
                <button
                  className="primary-button"
                  disabled={sending || !noteText.trim() || dictationBusy || pdfLoading || !selectedPatientId}
                  onClick={handleSend}
                  type="button"
                >
                  <Icon name="send" size={16} />
                  {sending ? "Preparing…" : "Send writeup"}
                </button>
              </div>
            </section>

            <aside className="side-column" aria-label="Discharge details">
              <section className="side-card checklist-card">
                <div className="side-card-head">
                  <h3>Discharge checklist</h3>
                  <span className="checklist-count">
                    {completedCount} of {checklist.length} complete
                  </span>
                </div>
                <div
                  className="checklist-progress"
                  role="progressbar"
                  aria-valuenow={checklistProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span style={{ width: `${checklistProgress}%` }} />
                </div>
                <ul className="checklist">
                  {checklist.map((item) => (
                    <li key={item.id}>
                      <button
                        aria-pressed={item.done}
                        className={`checklist-item ${item.done ? "is-done" : ""}`}
                        onClick={() => toggleChecklistItem(item.id)}
                        type="button"
                      >
                        <span className="checklist-box">
                          {item.done ? <Icon name="check" size={14} /> : null}
                        </span>
                        <span className="checklist-label">{item.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="side-card">
                <div className="side-card-head"><h3>Care team</h3></div>
                <ul className="team-list">
                  {careTeam.map((member) => (
                    <li className="team-member" key={member.name}>
                      <span className="team-avatar">{member.initials}</span>
                      <div className="team-copy">
                        <strong>{member.name}</strong>
                        <span>{member.role}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>

              <section className="side-card">
                <div className="side-card-head"><h3>Recent activity</h3></div>
                <ul className="activity-list">
                  {activity.map((entry, index) => (
                    <li className="activity-item" key={`${entry.description}-${index}`}>
                      <span className="activity-dot" aria-hidden="true" />
                      <div className="activity-copy">
                        <strong>{entry.description}</strong>
                        <span>{entry.time}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            </aside>
          </div>
        </div>
      </main>
    </div>
  )
}
