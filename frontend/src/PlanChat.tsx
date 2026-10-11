import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react"
import { askPlan, type ChatReply } from "./api"
import type { Language } from "./data"
import { t } from "./i18n"
import { Icon } from "./ui"

type Message = { from: "patient" } & { text: string } | ({ from: "assistant" } & ChatReply)

// Routes that must stand out: the reply tells the reader to act now.
const URGENT = new Set(["emergency", "crisis", "medication_mistake"])

/**
 * Questions about the patient's own Going-Home Plan. The answers come from the AI-Infra chatbot,
 * which only repeats the plan (with the lines it relied on) or sends the reader to their care team.
 * The conversation lives in this component only: nothing is saved, and closing the page clears it.
 */
export function PlanChat({ token, language }: { token?: string; language: Language }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const toggleRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLOListElement>(null)

  useEffect(() => { if (open) inputRef.current?.focus() }, [open])
  useEffect(() => { listRef.current?.lastElementChild?.scrollIntoView({ block: "end" }) }, [messages, pending])

  if (!token) return null

  const close = () => { setOpen(false); toggleRef.current?.focus() }

  const ask = async (question: string) => {
    const text = question.trim()
    if (!text || pending) return
    // The last six question/answer pairs go back with each question so "it" and "that one" resolve.
    const history: [string, string][] = []
    for (let i = 0; i + 1 < messages.length; i++) {
      const q = messages[i], a = messages[i + 1]
      if (q.from === "patient" && a.from === "assistant") history.push([q.text, a.text])
    }
    setMessages(prev => [...prev, { from: "patient", text }])
    setDraft(""); setPending(true); setError(undefined)
    try {
      const reply = await askPlan(token, text, history.slice(-6))
      setMessages(prev => [...prev, { from: "assistant", ...reply }])
    } catch {
      setError(t(language, "chatError"))
    } finally {
      setPending(false)
      inputRef.current?.focus()
    }
  }

  const submit = (event: FormEvent) => { event.preventDefault(); void ask(draft) }
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(draft) }
  }

  const suggestions = [t(language, "chatSuggestMeds"), t(language, "chatSuggestAppointments"), t(language, "chatSuggestWarnings")]
  const languageNote = t(language, "chatLanguageNote")

  return (
    <>
      {!open && (
        <button aria-expanded={false} aria-controls="plan-chat" className="plan-chat-toggle" onClick={() => setOpen(true)} ref={toggleRef} type="button">
          <Icon name="chat" size={20} />
          <span>{t(language, "chatOpen")}</span>
        </button>
      )}
      {open && (
        <section aria-labelledby="plan-chat-title" className="plan-chat" id="plan-chat" onKeyDown={e => { if (e.key === "Escape") close() }} role="dialog">
          <header className="plan-chat-head">
            <h2 id="plan-chat-title">{t(language, "chatTitle")}</h2>
            <button aria-label={t(language, "chatClose")} className="plan-chat-close" onClick={close} type="button">
              <Icon name="close" size={20} />
            </button>
          </header>
          <p className="plan-chat-seam">{t(language, "chatSeam")}</p>
          {languageNote && <p className="plan-chat-seam">{languageNote}</p>}

          <ol aria-live="polite" className="plan-chat-log" ref={listRef}>
            {messages.length === 0 && (
              <li className="plan-chat-suggestions">
                {suggestions.map(s => (
                  <button className="plan-chat-chip" key={s} onClick={() => void ask(s)} type="button">{s}</button>
                ))}
              </li>
            )}
            {messages.map((m, i) => m.from === "patient" ? (
              <li className="plan-chat-msg is-patient" key={i}>{m.text}</li>
            ) : (
              <li className={`plan-chat-msg is-assistant${URGENT.has(m.route) ? " is-urgent" : ""}`} key={i} role={URGENT.has(m.route) ? "alert" : undefined}>
                {URGENT.has(m.route) && <Icon name="warning" size={18} />}
                <span>{m.text}</span>
              </li>
            ))}
            {pending && <li className="plan-chat-msg is-assistant is-pending" role="status">{t(language, "chatThinking")}</li>}
          </ol>
          {error && <p className="plan-chat-error" role="alert">{error}</p>}

          <form className="plan-chat-form" onSubmit={submit}>
            <label className="sr-only" htmlFor="plan-chat-input">{t(language, "chatPlaceholder")}</label>
            <textarea
              id="plan-chat-input"
              maxLength={1000}
              onChange={e => setDraft(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={t(language, "chatPlaceholder")}
              ref={inputRef}
              rows={2}
              value={draft}
            />
            <button aria-label={t(language, "chatSend")} className="plan-chat-send" disabled={pending || !draft.trim()} type="submit">
              <Icon name="send" size={18} />
            </button>
          </form>
          <p className="plan-chat-privacy"><Icon name="lock" size={13} />{t(language, "chatPrivacy")}</p>
        </section>
      )}
    </>
  )
}
