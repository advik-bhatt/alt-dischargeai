import { useEffect, useRef, useState, type ReactNode } from "react"
import { BrandMark } from "./ui"
import "./landing.css"

// The public landing page. Claims are the product's own (see README) and the team deck's sourced
// figures (CMS HRRP; Healthcare Dive, FY2026). The hero shows a sample plan, labelled as a sample.

const reduceMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

/** True once the element has scrolled into view (at once when motion is reduced). */
function useInView<T extends HTMLElement>(threshold = 0.25) {
  const ref = useRef<T>(null)
  const [inView, setInView] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (reduceMotion() || !("IntersectionObserver" in window)) { setInView(true); return }
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setInView(true); io.disconnect() }
    }, { threshold })
    io.observe(el)
    return () => io.disconnect()
  }, [threshold])
  return [ref, inView] as const
}

function Reveal({ children, className = "", delay = 0 }: { children: ReactNode; className?: string; delay?: number }) {
  const [ref, inView] = useInView<HTMLDivElement>(0.15)
  return <div className={`gh-reveal ${inView ? "is-in" : ""} ${className}`} ref={ref} style={{ transitionDelay: `${delay}ms` }}>{children}</div>
}

const paths: Record<string, ReactNode> = {
  pill: <><rect x="3" y="9" width="18" height="6" rx="3" transform="rotate(-45 12 12)" /><path d="m9.5 9.5 5 5" /></>,
  calendar: <><rect x="4" y="5" width="16" height="15" rx="2" /><path d="M8 3v4M16 3v4M4 10h16" /><path d="m9 15 2 2 4-4" /></>,
  globe: <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
  speaker: <><path d="M11 5 6 9H3v6h3l5 4z" /><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13" /></>,
  chat: <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />,
  people: <><circle cx="9" cy="8" r="3" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9" r="2.5" /><path d="M16 14.5a5 5 0 0 1 5 5" /></>,
  lock: <><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></>,
  check: <path d="m5 12 4.5 4.5L19 7" />,
  arrow: <path d="M5 12h14m-5-5 5 5-5 5" />,
}
function Glyph({ name, size = 22 }: { name: keyof typeof paths; size?: number }) {
  return (
    <svg aria-hidden="true" fill="none" height={size} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} viewBox="0 0 24 24" width={size}>
      {paths[name]}
    </svg>
  )
}

/** The hero visual: a sample plan as the patient sees it. The chart line rewrites itself once on load. */
function PlanPreview() {
  const [ref, inView] = useInView<HTMLDivElement>(0.3)
  return (
    <div aria-label="Sample patient plan" className={`gh-preview ${inView ? "is-in" : ""}`} ref={ref} role="img">
      <div className="gh-preview-bar">
        <span className="gh-preview-mark"><BrandMark size={18} /></span>
        <span>Your Going-Home Plan</span>
        <span className="gh-preview-tag">Sample</span>
      </div>
      <div className="gh-preview-body">
        <p className="gh-preview-label">Your medicines</p>
        <div className="gh-preview-rewrite">
          <p className="gh-preview-jargon">Metoprolol succ ER 25 mg PO QD</p>
          <p className="gh-preview-plain">
            <span className="gh-preview-box"><Glyph name="check" size={14} /></span>
            <span><strong>1 heart pill</strong>, once a day</span>
          </p>
        </div>
        <p className="gh-preview-plain is-static">
          <span className="gh-preview-box is-empty" />
          <span><strong>Furosemide 40 mg</strong>, every morning, for swelling</span>
        </p>
        <p className="gh-preview-label">Your next visit</p>
        <p className="gh-preview-visit"><Glyph name="calendar" size={18} /> See your heart doctor within 2 weeks</p>
        <div className="gh-preview-chat">
          <p className="gh-preview-q">Can I take ibuprofen?</p>
          <p className="gh-preview-a">No. It is not in your Going-Home Plan, so do not take it unless your doctor or nurse tells you to.</p>
        </div>
      </div>
      <p className="gh-preview-foot"><Glyph name="lock" size={14} /> Private link, deleted after 30 days</p>
    </div>
  )
}

const stats = [
  { value: "Up to 3%", label: "of a hospital's Medicare payments is cut when too many patients return within 30 days" },
  { value: "78%", label: "of hospitals were penalized for readmissions in FY2026" },
  { value: "4", label: "languages for every plan: English, Spanish, Chinese and Arabic" },
  { value: "30 days", label: "until the plan, its files and its link are deleted" },
]

const steps = [
  { title: "The clinician adds notes", body: "Dictate, upload a PDF, or paste the discharge notes exactly as they are written today." },
  { title: "Discharge AI writes the plan", body: "Medicines and follow-up visits in plain words. Anything a clinician should double-check is flagged." },
  { title: "The patient opens a private link", body: "They confirm their date of birth and see today's medicines and their next visit. No account needed." },
  { title: "They check in every day for 30 days", body: "Medicines taken, warning signs from their own plan, weight, and one question to check they remember. Problems show up on the care team's dashboard." },
]

const safeguards = [
  { title: "Quoted, not invented", body: "Every line of the plan carries word-for-word quotes from the clinician's notes, and code checks that each quote is really there." },
  { title: "Reviewed before it's sent", body: "A second agent checks the plan against the notes for anything missing, wrong or made up, plus the reading level. Flagged lines are fixed and checked again." },
  { title: "Unsure goes to a clinician", body: "An unclear medicine name or a problem that can't be fixed marks the plan for a clinician to check instead of approving it." },
]

const features: { icon: keyof typeof paths; title: string; body: string }[] = [
  { icon: "pill", title: "A daily medicine checklist", body: "Which pills, how much, and when, grouped by time of day and checked off as they go." },
  { icon: "calendar", title: "Follow-up visits, spelled out", body: "Who to see and by when, in the same plan as the medicines." },
  { icon: "globe", title: "In the patient's language", body: "English, Spanish, Chinese and Arabic. Every translation is checked against the original plan." },
  { icon: "speaker", title: "Read aloud", body: "Any section can be played out loud, in the language on screen." },
  { icon: "chat", title: "Questions, answered from the plan", body: "Patients ask about their medicines and visits. Anything the plan does not cover goes to their care team, and emergencies to 911." },
  { icon: "people", title: "Caregivers included", body: "A caregiver opens the same plan with the patient's date of birth." },
]

const team = "Junaid, Yasir (MD), Jelani, Sameer, Jerome, Valerie, Advik and Meg (Economics)"

export function Landing({ onSignIn }: { onSignIn: () => void }) {
  const [scrolled, setScrolled] = useState(false)
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8)
    onScroll()
    window.addEventListener("scroll", onScroll, { passive: true })
    return () => window.removeEventListener("scroll", onScroll)
  }, [])

  return (
    <div className="gh">
      <header className={`gh-nav ${scrolled ? "is-scrolled" : ""}`}>
        <a className="gh-logo" href="/">
          <span className="gh-logo-mark"><BrandMark size={22} /></span>
          Discharge AI
        </a>
        <nav aria-label="Sections" className="gh-nav-links">
          <a href="#how">How it works</a>
          <a href="#features">Features</a>
          <a href="#safety">Safety</a>
          <a href="#privacy">Privacy</a>
        </nav>
        <div className="gh-nav-actions">
          <button className="gh-btn gh-btn-primary" onClick={onSignIn} type="button">Sign in</button>
        </div>
      </header>

      <main>
        <div className="gh-hero-band">
        <section aria-labelledby="gh-title" className="gh-hero">
          <div className="gh-hero-copy">
            <p className="gh-kicker gh-enter">For hospitals and the patients they send home</p>
            <h1 className="gh-enter" id="gh-title" style={{ animationDelay: "80ms" }}>Discharge, made plain.</h1>
            <p className="gh-lede gh-enter" style={{ animationDelay: "160ms" }}>
              Discharge AI turns a clinician's discharge notes into a plain-language plan for the patient: which medicines to take, when, and who to see next. In their own language, behind a private link that deletes itself after 30 days.
            </p>
            <div className="gh-hero-actions gh-enter" style={{ animationDelay: "240ms" }}>
              <button className="gh-btn gh-btn-primary gh-btn-lg" onClick={onSignIn} type="button">Try the demo <Glyph name="arrow" size={18} /></button>
              <a className="gh-btn gh-btn-quiet gh-btn-lg" href="#how">How it works</a>
            </div>
          </div>
          <div className="gh-hero-visual gh-enter" style={{ animationDelay: "200ms" }}>
            <PlanPreview />
          </div>
        </section>
        </div>

        <section aria-label="Why it matters" className="gh-stats">
          <dl>
            {stats.map((s, i) => (
              <Reveal className="gh-stat" delay={i * 80} key={s.value}>
                <dt>{s.value}</dt>
                <dd>{s.label}</dd>
              </Reveal>
            ))}
          </dl>
          <p className="gh-source">Sources: CMS Hospital Readmissions Reduction Program; Healthcare Dive.</p>
        </section>

        <section aria-labelledby="problem-title" className="gh-section gh-problem">
          <Reveal className="gh-problem-copy">
            <p className="gh-kicker">The problem</p>
            <h2 id="problem-title">Discharge papers are written for clinicians.</h2>
            <p>Patients go home with medical shorthand, usually in English only. They are unsure which pills to take and when to see their doctor, recovery stalls, and many end up back in the hospital.</p>
            <p>Readmissions have many causes. Two of the most common are preventable: <strong>missed medications</strong> and <strong>missed follow-up visits</strong>. Discharge AI makes those two things impossible to misread.</p>
          </Reveal>
          <Reveal className="gh-compare" delay={120}>
            <div className="gh-compare-col">
              <p className="gh-compare-label">What the chart says</p>
              <p className="gh-compare-jargon">Metoprolol succ ER 25 mg PO QD, follow up cardiology 1 to 2 weeks</p>
            </div>
            <span aria-hidden="true" className="gh-compare-arrow"><Glyph name="arrow" size={22} /></span>
            <div className="gh-compare-col">
              <p className="gh-compare-label">What the patient reads</p>
              <p className="gh-compare-plain">Take one heart pill once a day, and see your heart doctor within two weeks.</p>
            </div>
          </Reveal>
        </section>

        <section aria-labelledby="how-title" className="gh-section gh-band" id="how">
          <Reveal className="gh-section-head">
            <p className="gh-kicker">How it works</p>
            <h2 id="how-title">From discharge notes to a plan in minutes.</h2>
          </Reveal>
          <ol className="gh-steps">
            {steps.map((s, i) => (
              <li key={s.title}>
                <Reveal delay={i * 120}>
                  <span className="gh-step-num">{i + 1}</span>
                  <h3>{s.title}</h3>
                  <p>{s.body}</p>
                </Reveal>
              </li>
            ))}
          </ol>
        </section>

        <section aria-labelledby="features-title" className="gh-section" id="features">
          <Reveal className="gh-section-head">
            <p className="gh-kicker">What patients get</p>
            <h2 id="features-title">Everything they need to recover at home, in one place.</h2>
          </Reveal>
          <ul className="gh-features">
            {features.map((f, i) => (
              <li key={f.title}>
                <Reveal delay={(i % 3) * 90}>
                  <span className="gh-feature-icon"><Glyph name={f.icon} /></span>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </Reveal>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="safety-title" className="gh-section gh-band" id="safety">
          <Reveal className="gh-section-head">
            <p className="gh-kicker">Safety</p>
            <h2 id="safety-title">Every line traces back to the clinician's notes.</h2>
          </Reveal>
          <ul className="gh-features">
            {safeguards.map((g, i) => (
              <li key={g.title}>
                <Reveal delay={i * 90}>
                  <span className="gh-feature-icon"><Glyph name="check" /></span>
                  <h3>{g.title}</h3>
                  <p>{g.body}</p>
                </Reveal>
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="privacy-title" className="gh-privacy" id="privacy">
          <Reveal className="gh-privacy-inner">
            <div>
              <p className="gh-kicker gh-kicker-light">Privacy</p>
              <h2 id="privacy-title">Private by design. Gone in 30 days.</h2>
            </div>
            <ul>
              <li><Glyph name="lock" size={20} />Each plan sits behind its own unguessable link, opened with the patient's date of birth.</li>
              <li><Glyph name="check" size={20} />The plan, its files and its link are deleted 30 days after creation, and every deletion leaves a receipt.</li>
              <li><Glyph name="check" size={20} />No patient details are written to logs.</li>
            </ul>
          </Reveal>
        </section>

        <section aria-labelledby="cta-title" className="gh-section gh-cta">
          <Reveal>
            <h2 id="cta-title">See it with a sample patient.</h2>
            <p>Sign in as the demo clinician, or open the sample patient's plan, from the sign-in page.</p>
            <button className="gh-btn gh-btn-primary gh-btn-lg" onClick={onSignIn} type="button">Try the demo <Glyph name="arrow" size={18} /></button>
          </Reveal>
        </section>
      </main>

      <footer className="gh-footer">
        <div className="gh-footer-top">
          <a className="gh-logo" href="/"><span className="gh-logo-mark"><BrandMark size={20} /></span>Discharge AI</a>
          <nav aria-label="Footer" className="gh-footer-links">
            <button onClick={onSignIn} type="button">Sign in</button>
            <a href="/api/docs/">API docs</a>
            <a href="#privacy">Privacy</a>
          </nav>
        </div>
        <p className="gh-footer-team">Built by Team 10 for Ops Unleashed Challenge 1: {team}.</p>
      </footer>
    </div>
  )
}
