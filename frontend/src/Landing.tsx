import { useEffect, useRef, useState, type ReactNode } from "react"
import "./landing.css"

// The team's pitch deck (DischargeAI_Presentation.pptx, four slides) as the public landing page.
// Copy is the deck's own; the jargon example comes from slide 3's speaker notes.

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/** Adds `is-in` once the element scrolls into view (immediately when motion is reduced). */
function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduceMotion() || !("IntersectionObserver" in window)) { setShown(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setShown(true); io.disconnect() }
    }, { threshold: 0.2 })
    io.observe(el)
    return () => io.disconnect()
  }, [])
  return [ref, shown] as const
}

function Reveal({ as: Tag = "div", className = "", children }: { as?: "div" | "section" | "li" | "ul" | "ol"; className?: string; children: ReactNode }) {
  const [ref, shown] = useReveal<HTMLElement>()
  return <Tag className={`lp-reveal ${shown ? "is-in" : ""} ${className}`} ref={ref as never}>{children}</Tag>
}

/** "Up to 3%" counts up when it comes into view. */
function CountUp({ to, suffix }: { to: number; suffix: string }) {
  const [ref, shown] = useReveal<HTMLSpanElement>()
  const [value, setValue] = useState(0)
  useEffect(() => {
    if (!shown) return
    if (reduceMotion()) { setValue(to); return }
    const start = performance.now()
    let frame = 0
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / 900)
      setValue(Math.round(to * (1 - Math.pow(1 - p, 3))))
      if (p < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [shown, to])
  return <span ref={ref}>{value}{suffix}</span>
}

// Line icons drawn to match the deck's white-on-coral glyphs.
const glyphs: Record<string, ReactNode> = {
  code: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 6l-3 12" />,
  steth: <><path d="M6 3v6a5 5 0 0 0 10 0V3" /><path d="M11 14v2a4 4 0 0 0 8 0v-1" /><circle cx="19" cy="13" r="2" /></>,
  chart: <><path d="M4 19h16" /><path d="m5 15 4-4 3 3 6-6" /><path d="M15 8h3v3" /></>,
  patient: <><circle cx="12" cy="7" r="3.5" /><path d="M5 21a7 7 0 0 1 14 0" /><path d="M9.5 15.5h5M12 13v5" /></>,
  hospital: <><rect x="5" y="3" width="14" height="18" rx="1.5" /><path d="M12 6.5v4M10 8.5h4M9 21v-4h6v4M8.5 13.5h1M14.5 13.5h1" /></>,
  pills: <><rect x="2.8" y="8" width="11" height="6" rx="3" transform="rotate(-45 8.3 11)" /><path d="m6.3 9 4 4" /><circle cx="16.5" cy="15.5" r="4.5" /><path d="m13.3 18.7 6.4-6.4" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /><path d="m9 15 2 2 4-4" /></>,
  doctor: <><circle cx="12" cy="7" r="3.5" /><path d="M5 21a7 7 0 0 1 14 0" /><path d="M9 14.5v3a3 3 0 0 0 6 0v-3" /></>,
  wand: <><path d="m4 20 11-11" /><path d="m13 7 2-2 4 4-2 2z" /><path d="M7 4v3M5.5 5.5h3M19 15v3M17.5 16.5h3" /></>,
  link: <><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
}
function Glyph({ name, size = 22 }: { name: keyof typeof glyphs; size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} viewBox="0 0 24 24" width={size}>
      {glyphs[name]}
    </svg>
  )
}

const team: { name: string; role: string; icon: keyof typeof glyphs; accent?: boolean }[] = [
  { name: "Junaid", role: "Computer Science", icon: "code" },
  { name: "Yasir", role: "MD", icon: "steth", accent: true },
  { name: "Jelani", role: "Computer Science", icon: "code" },
  { name: "Sameer", role: "Computer Science", icon: "code" },
  { name: "Jerome", role: "Computer Science", icon: "code" },
  { name: "Valerie", role: "Computer Science", icon: "code" },
  { name: "Advik", role: "Computer Science", icon: "code" },
  { name: "Meg", role: "Economics", icon: "chart", accent: true },
]

const steps: { icon: keyof typeof glyphs; title: string; body: string }[] = [
  { icon: "doctor", title: "Doctor adds notes", body: "Dictates, uploads or pastes the discharge notes, as they're written today" },
  { icon: "wand", title: "AI makes it clear", body: "Rewrites the meds and follow-up visit in plain words, in the patient's own language" },
  { icon: "link", title: "Patient gets a link", body: "A secure link with their daily meds schedule and next clinic visit" },
]

/** Slide 3's speaker-note example: the chart line turns into the patient's line. */
function JargonToPlain() {
  const [ref, shown] = useReveal<HTMLDivElement>()
  return (
    <div className={`lp-translate ${shown ? "is-in" : ""}`} ref={ref}>
      <p className="lp-translate-label">What the chart says</p>
      <p className="lp-translate-before">Metoprolol succ ER 25 mg PO QD, follow up cardiology 1 to 2 weeks</p>
      <span aria-hidden="true" className="lp-translate-arrow"><Glyph name="arrow" size={20} /></span>
      <p className="lp-translate-label">What the patient reads</p>
      <p className="lp-translate-after">Take one heart pill once a day, and see your heart doctor within two weeks.</p>
    </div>
  )
}

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div className="lp">
      <header className="lp-nav">
        <a className="lp-brand" href="/">
          <span aria-hidden="true" className="lp-brand-mark">+</span>
          Discharge AI
        </a>
        <nav aria-label="Page sections" className="lp-nav-links">
          <a href="#problem">The problem</a>
          <a href="#solution">Our solution</a>
          <a href="#how">How it works</a>
        </nav>
        <button className="lp-button" onClick={onSignIn} type="button">Sign in</button>
      </header>

      <main>
        <section aria-labelledby="lp-title" className="lp-hero">
          <div className="lp-hero-copy">
            <p className="lp-eyebrow lp-rise" style={{ animationDelay: "0ms" }}>Ops Unleashed Challenge 1 · Team 10</p>
            <h1 className="lp-rise" id="lp-title" style={{ animationDelay: "120ms" }}>Discharge AI</h1>
            <p className="lp-hero-lede lp-rise" style={{ animationDelay: "240ms" }}>From discharge notes to clear instructions.</p>
            <div className="lp-hero-actions lp-rise" style={{ animationDelay: "360ms" }}>
              <button className="lp-button lp-button-large" onClick={onSignIn} type="button">Sign in</button>
              <a className="lp-button-ghost" href="#how">See how it works</a>
            </div>
          </div>
          <aside aria-label="Team 10" className="lp-team">
            <h2 className="lp-eyebrow">Team 10</h2>
            <ul>
              {team.map((m, i) => (
                <li className="lp-rise" key={m.name} style={{ animationDelay: `${300 + i * 70}ms` }}>
                  <span className={`lp-team-icon ${m.accent ? "is-accent" : ""}`}><Glyph name={m.icon} size={16} /></span>
                  <span className="lp-team-name">{m.name}</span>
                  <span className={`lp-team-role ${m.accent ? "is-accent" : ""}`}>{m.role}</span>
                </li>
              ))}
            </ul>
          </aside>
        </section>

        <section aria-labelledby="problem-title" className="lp-section" id="problem">
          <Reveal>
            <p className="lp-eyebrow">The problem</p>
            <h2 className="lp-h2" id="problem-title">Patients leave confused, then return</h2>
          </Reveal>
          <div className="lp-split">
            <Reveal className="lp-card lp-card-soft">
              <h3 className="lp-card-title"><span className="lp-icon"><Glyph name="patient" /></span>A burden on the patient</h3>
              <ul className="lp-list">
                <li>Discharge papers are full of medical jargon, usually in English only</li>
                <li>Patients go home unsure about medications and follow-up care</li>
                <li>Recovery stalls and they end up back in the hospital: another trip in, another trip out</li>
              </ul>
            </Reveal>
            <Reveal className="lp-card lp-card-dark">
              <h3 className="lp-card-title"><span className="lp-icon"><Glyph name="hospital" /></span>A cost to the hospital</h3>
              <p className="lp-stat">Up to <CountUp to={3} suffix="%" /></p>
              <p className="lp-stat-label">cut from a hospital's Medicare payments if too many patients return within 30 days</p>
              <p className="lp-card-note"><strong>CMS tracks 6 conditions:</strong> heart attack, heart failure, pneumonia, COPD, bypass surgery, hip/knee replacement</p>
            </Reveal>
          </div>
          <p className="lp-sources">Sources: CMS Hospital Readmissions Reduction Program; Healthcare Dive (78% of hospitals penalized in FY2026)</p>
        </section>

        <section aria-labelledby="solution-title" className="lp-section lp-section-tint" id="solution">
          <Reveal>
            <p className="lp-eyebrow">Our solution: Discharge AI</p>
            <h2 className="lp-h2" id="solution-title">Clear instructions on meds and follow-ups</h2>
            <p className="lp-intro">Readmissions have many medical and psychosocial causes.<br /><strong>The two most common preventable causes of readmissions:</strong></p>
          </Reveal>
          <div className="lp-split">
            <Reveal className="lp-card lp-card-row">
              <span className="lp-icon lp-icon-large"><Glyph name="pills" size={30} /></span>
              <div><h3 className="lp-card-title-plain">Missed medications</h3><p>Which pills, how much, and when to take</p></div>
            </Reveal>
            <Reveal className="lp-card lp-card-row">
              <span className="lp-icon lp-icon-large"><Glyph name="calendar" size={30} /></span>
              <div><h3 className="lp-card-title-plain">Missed follow-up visits</h3><p>With whom and when</p></div>
            </Reveal>
          </div>
          <JargonToPlain />
          <Reveal className="lp-goal">
            <p>Our goal is to make it as easy as possible for the patient to follow the discharge instructions in these two areas.</p>
          </Reveal>
        </section>

        <section aria-labelledby="how-title" className="lp-section" id="how">
          <Reveal>
            <p className="lp-eyebrow">How it works</p>
            <h2 className="lp-h2" id="how-title">From discharge notes to clear instructions</h2>
          </Reveal>
          <Reveal as="ol" className="lp-steps">
            {steps.map((s, i) => (
              <li className="lp-step" key={s.title} style={{ transitionDelay: `${i * 180}ms` }}>
                <span className="lp-icon lp-icon-large"><Glyph name={s.icon} size={30} /></span>
                <h3 className="lp-card-title-plain">{i + 1}. {s.title}</h3>
                <p>{s.body}</p>
                {i < steps.length - 1 && <span aria-hidden="true" className="lp-step-arrow"><Glyph name="arrow" size={22} /></span>}
              </li>
            ))}
          </Reveal>
          <Reveal className="lp-privacy">
            <Glyph name="lock" size={20} />
            <p><strong>Private by design:</strong> links expire and patient data is deleted after 30 days</p>
          </Reveal>
        </section>

        <section aria-labelledby="cta-title" className="lp-cta">
          <Reveal>
            <h2 id="cta-title">See it with a sample patient</h2>
            <p>Sign in as the demo doctor, or open the demo patient link, from the sign-in page.</p>
            <button className="lp-button lp-button-large" onClick={onSignIn} type="button">Sign in</button>
          </Reveal>
        </section>
      </main>

      <footer className="lp-footer">
        <p>Discharge AI · Team 10 · Ops Unleashed Challenge 1</p>
      </footer>
    </div>
  )
}
