import { useEffect, useMemo, useState } from "react"
import { Icon } from "./ui"
import type { DischargePlan, Language } from "./data"
import { getCheckIns, postCheckIn, type CheckInFlag, type FollowUp } from "./api"

// The 30 days after discharge: a daily check-in on the patient's own plan. Every question comes from
// the plan (its medicines, its warning signs); the server applies the flag rules and the care team
// sees the result on the dashboard. Nothing here is written by a model.

type Strings = Record<
  | "title" | "dayOf" | "daysDone" | "medsQ" | "medsAll" | "medsSome" | "medsNone" | "signsQ" | "signsHint" | "getHelpNow"
  | "callDoctor" | "weightQ" | "lb" | "teachQ" | "teachRight" | "teachWrong" | "submit" | "sending" | "doneToday" | "again"
  | "okResult" | "urgentResult" | "attentionResult" | "missedMeds" | "weightUp" | "careTeam" | "error",
  string
>

const STRINGS: Record<Language, Strings> = {
  en: {
    title: "Daily check-in", dayOf: "Day {day} of 30", daysDone: "Checked in {n} of {day} days",
    medsQ: "Did you take today's medicines?", medsAll: "All of them", medsSome: "Some", medsNone: "None",
    signsQ: "Do you have any of these today?", signsHint: "Tap any that apply. Leave them all off if you have none.",
    getHelpNow: "Get help right away", callDoctor: "Call your doctor",
    weightQ: "Your weight today (optional)", lb: "lb",
    teachQ: "Quick check: when do you take {name}?", teachRight: "That's right.", teachWrong: "Your plan says: {when}.",
    submit: "Send check-in", sending: "Sending…", doneToday: "You checked in today.", again: "Check in again",
    okResult: "Thank you. Keep following your plan, and check in again tomorrow.",
    urgentResult: "Your plan says to get help right away for this:",
    attentionResult: "Your care team will see this check-in. If you are worried, call them.",
    missedMeds: "Take your medicines the way your plan says. If you are not sure how, ask your care team.",
    weightUp: "Your weight is up since your last check-in.",
    careTeam: "Your care team sees your check-ins, but not around the clock. In an emergency, call 911.",
    error: "Could not send. Try again.",
  },
  es: {
    title: "Control diario", dayOf: "Día {day} de 30", daysDone: "Control hecho {n} de {day} días",
    medsQ: "¿Tomó hoy sus medicinas?", medsAll: "Todas", medsSome: "Algunas", medsNone: "Ninguna",
    signsQ: "¿Tiene hoy alguno de estos?", signsHint: "Toque los que correspondan. Si no tiene ninguno, no toque nada.",
    getHelpNow: "Busque ayuda de inmediato", callDoctor: "Llame a su médico",
    weightQ: "Su peso hoy (opcional)", lb: "lb",
    teachQ: "Repaso rápido: ¿cuándo toma {name}?", teachRight: "Correcto.", teachWrong: "Su plan dice: {when}.",
    submit: "Enviar control", sending: "Enviando…", doneToday: "Ya hizo su control de hoy.", again: "Hacer otro control",
    okResult: "Gracias. Siga su plan y vuelva a hacer su control mañana.",
    urgentResult: "Su plan dice que busque ayuda de inmediato por esto:",
    attentionResult: "Su equipo de atención verá este control. Si está preocupado, llámelos.",
    missedMeds: "Tome sus medicinas como dice su plan. Si no está seguro de cómo hacerlo, pregunte a su equipo de atención.",
    weightUp: "Su peso subió desde su último control.",
    careTeam: "Su equipo de atención ve sus controles, pero no las 24 horas. En una emergencia, llame al 911.",
    error: "No se pudo enviar. Inténtelo de nuevo.",
  },
  zh: {
    title: "每日签到", dayOf: "第 {day} 天（共 30 天）", daysDone: "已签到 {n} 天（共 {day} 天）",
    medsQ: "今天的药都吃了吗？", medsAll: "全部吃了", medsSome: "吃了一部分", medsNone: "都没吃",
    signsQ: "今天有以下任何情况吗？", signsHint: "点选符合的项目。如果都没有，请不要点选。",
    getHelpNow: "立即求助", callDoctor: "给医生打电话",
    weightQ: "今天的体重（选填）", lb: "磅",
    teachQ: "小测验：{name} 什么时候吃？", teachRight: "答对了。", teachWrong: "您的计划写的是：{when}。",
    submit: "提交签到", sending: "正在提交…", doneToday: "您今天已签到。", again: "再次签到",
    okResult: "谢谢。请继续按计划进行，明天再来签到。",
    urgentResult: "您的计划说出现以下情况要立即求助：",
    attentionResult: "您的医护团队会看到这次签到。如果您担心，请给他们打电话。",
    missedMeds: "请按照计划吃药。如果不确定怎么吃，请询问您的医护团队。",
    weightUp: "您的体重比上次签到时增加了。",
    careTeam: "您的医护团队可以看到您的签到，但不是全天候查看。如遇紧急情况，请拨打 911。",
    error: "提交失败，请重试。",
  },
  ar: {
    title: "المتابعة اليومية", dayOf: "اليوم {day} من 30", daysDone: "تمت المتابعة في {n} من {day} أيام",
    medsQ: "هل تناولت أدويتك اليوم؟", medsAll: "كلها", medsSome: "بعضها", medsNone: "لا شيء منها",
    signsQ: "هل لديك أي من هذه اليوم؟", signsHint: "اضغط على ما ينطبق عليك. لا تضغط على شيء إذا لم يكن لديك أي منها.",
    getHelpNow: "اطلب المساعدة فورًا", callDoctor: "اتصل بطبيبك",
    weightQ: "وزنك اليوم (اختياري)", lb: "رطل",
    teachQ: "سؤال سريع: متى تتناول {name}؟", teachRight: "إجابة صحيحة.", teachWrong: "تقول خطتك: {when}.",
    submit: "إرسال المتابعة", sending: "جارٍ الإرسال…", doneToday: "لقد أكملت متابعة اليوم.", again: "متابعة مرة أخرى",
    okResult: "شكرًا لك. استمر في اتباع خطتك، وعد للمتابعة غدًا.",
    urgentResult: "تقول خطتك أن تطلب المساعدة فورًا في هذه الحالة:",
    attentionResult: "سيرى فريق رعايتك هذه المتابعة. إذا كنت قلقًا، اتصل بهم.",
    missedMeds: "تناول أدويتك كما تقول خطتك. إذا لم تكن متأكدًا من الطريقة، اسأل فريق رعايتك.",
    weightUp: "زاد وزنك منذ آخر متابعة.",
    careTeam: "يرى فريق رعايتك متابعاتك، لكن ليس على مدار الساعة. في حالات الطوارئ، اتصل بالرقم 911.",
    error: "تعذّر الإرسال. حاول مرة أخرى.",
  },
}

const fill = (s: string, params: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (m, k: string) => String(params[k] ?? m))
const CALL_DOCTOR_PREFIX = "Call your doctor if: "

/** The teach-back question for the day: one scheduled medicine, rotating, answered with the plan's own schedule labels. */
export function teachBackFor(plan: DischargePlan, day: number) {
  const groups = plan.medications.groups.filter(g => g.key !== "asNeeded" && g.items.length)
  const labels = [...new Set(groups.map(g => g.label))]
  const names = [...new Set(groups.flatMap(g => g.items.map(i => i.name)))]
  if (labels.length < 2 || !names.length) return undefined
  const name = names[day % names.length]
  return { name, options: labels, answers: groups.filter(g => g.items.some(i => i.name === name)).map(g => g.label) }
}

export function CheckIn({ token, plan, language, by }: { token: string; plan: DischargePlan; language: Language; by: "patient" | "caregiver" }) {
  const s = STRINGS[language]
  const [followUp, setFollowUp] = useState<FollowUp>()
  const [meds, setMeds] = useState<"all" | "some" | "none">()
  const [urgent, setUrgent] = useState<string[]>([])
  const [callDoctor, setCallDoctor] = useState<string[]>([])
  const [weight, setWeight] = useState("")
  const [teachAnswer, setTeachAnswer] = useState<string>()
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<{ flags: CheckInFlag[]; urgentSigns: string[] }>()
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    let active = true
    getCheckIns(token).then(r => { if (active) setFollowUp(r.followUp) }).catch(() => undefined)
    return () => { active = false }
  }, [token])

  const day = followUp?.day ?? 1
  const hasMeds = plan.medications.groups.some(g => g.key !== "asNeeded" && g.items.length)
  const callDoctorSigns = plan.generalInstructions.filter(l => l.startsWith(CALL_DOCTOR_PREFIX)).map(l => l.slice(CALL_DOCTOR_PREFIX.length))
  const teach = useMemo(() => teachBackFor(plan, day), [plan, day])
  const toggle = (list: string[], set: (v: string[]) => void, value: string) => set(list.includes(value) ? list.filter(v => v !== value) : [...list, value])
  const weightLb = weight.trim() ? Number(weight) : undefined
  const weightValid = weightLb === undefined || (Number.isFinite(weightLb) && weightLb >= 40 && weightLb <= 800)

  const submit = async () => {
    if (sending || (hasMeds && !meds) || !weightValid) return
    setSending(true); setError(undefined)
    try {
      const r = await postCheckIn({
        token, by, language, meds: hasMeds ? meds! : "no_meds", urgentSigns: urgent, callDoctorSigns: callDoctor,
        ...(weightLb !== undefined ? { weightLb } : {}),
        ...(teach && teachAnswer ? { teachBack: { medicine: teach.name, correct: teach.answers.includes(teachAnswer) } } : {}),
      })
      setResult({ flags: r.checkin.flags, urgentSigns: urgent }); setFollowUp(r.followUp); setEditing(false)
      setMeds(undefined); setUrgent([]); setCallDoctor([]); setWeight(""); setTeachAnswer(undefined)
    } catch { setError(s.error) }
    finally { setSending(false) }
  }

  const showForm = editing || (!result && !followUp?.checkedInToday)
  const codes = new Set(result?.flags.map(f => f.code))

  return (
    <section className={`patient-section checkin${result?.flags.some(f => f.level === "urgent") ? " checkin-urgent" : ""}`} aria-labelledby="checkin-head">
      <div className="checkin-head">
        <h2 id="checkin-head" className="patient-section-title"><Icon name="calendar" size={22} /> {s.title}</h2>
        <span className="checkin-day">{fill(s.dayOf, { day })}</span>
      </div>
      {followUp && <CheckInDots followUp={followUp} label={fill(s.daysDone, { n: followUp.daysCheckedIn, day })} />}

      {result && !editing && (
        <div className="checkin-result" role="status">
          {codes.has("warning_sign") ? <>
            <p className="checkin-result-lead">{s.urgentResult}</p>
            <ul className="warning-signs-list">{result.urgentSigns.map(sign => <li key={sign}>{sign}</li>)}</ul>
            {plan.warningSigns.emergencyLine && <p className="warning-signs-emergency"><Icon name="warning" size={20} /> {plan.warningSigns.emergencyLine}</p>}
          </> : result.flags.length ? <>
            <p className="checkin-result-lead">{s.attentionResult}</p>
            {(codes.has("missed_some_meds") || codes.has("missed_all_meds")) && <p>{s.missedMeds}</p>}
            {(codes.has("weight_gain_day") || codes.has("weight_gain_week")) && <p>{s.weightUp}</p>}
          </> : <p className="checkin-result-lead">{s.okResult}</p>}
        </div>
      )}
      {!showForm && !result && <p className="checkin-result-lead">{s.doneToday}</p>}
      {!showForm && <button className="secondary-button checkin-again" onClick={() => { setEditing(true); setResult(undefined) }} type="button">{s.again}</button>}

      {showForm && <div className="checkin-form">
        {hasMeds && <fieldset className="checkin-q">
          <legend>{s.medsQ}</legend>
          <div className="checkin-choices">
            {(["all", "some", "none"] as const).map(v => (
              <button aria-pressed={meds === v} className={`checkin-choice${meds === v ? " is-on" : ""}`} key={v} onClick={() => setMeds(v)} type="button">
                {v === "all" ? s.medsAll : v === "some" ? s.medsSome : s.medsNone}
              </button>
            ))}
          </div>
        </fieldset>}

        {(plan.warningSigns.signs.length > 0 || callDoctorSigns.length > 0) && <fieldset className="checkin-q">
          <legend>{s.signsQ}</legend>
          <p className="checkin-hint">{s.signsHint}</p>
          {plan.warningSigns.signs.length > 0 && <>
            <p className="checkin-group checkin-group-urgent">{s.getHelpNow}</p>
            <div className="checkin-chips">{plan.warningSigns.signs.map(sign => (
              <button aria-pressed={urgent.includes(sign)} className={`checkin-chip is-urgent${urgent.includes(sign) ? " is-on" : ""}`} key={sign} onClick={() => toggle(urgent, setUrgent, sign)} type="button">{sign}</button>
            ))}</div>
          </>}
          {callDoctorSigns.length > 0 && <>
            <p className="checkin-group">{s.callDoctor}</p>
            <div className="checkin-chips">{callDoctorSigns.map(sign => (
              <button aria-pressed={callDoctor.includes(sign)} className={`checkin-chip${callDoctor.includes(sign) ? " is-on" : ""}`} key={sign} onClick={() => toggle(callDoctor, setCallDoctor, sign)} type="button">{sign}</button>
            ))}</div>
          </>}
        </fieldset>}

        <label className="checkin-q checkin-weight">
          <span>{s.weightQ}</span>
          <span className="checkin-weight-row">
            <input aria-invalid={!weightValid} inputMode="decimal" max={800} min={40} onChange={e => setWeight(e.target.value)} step="0.1" type="number" value={weight} />
            <span>{s.lb}</span>
          </span>
        </label>

        {teach && <fieldset className="checkin-q">
          <legend>{fill(s.teachQ, { name: teach.name })}</legend>
          <div className="checkin-choices">
            {teach.options.map(label => (
              <button aria-pressed={teachAnswer === label} className={`checkin-choice${teachAnswer === label ? " is-on" : ""}`} disabled={!!teachAnswer} key={label} onClick={() => setTeachAnswer(label)} type="button">{label}</button>
            ))}
          </div>
          {teachAnswer && <p className="checkin-hint" role="status">{teach.answers.includes(teachAnswer) ? s.teachRight : fill(s.teachWrong, { when: teach.answers.join(", ") })}</p>}
        </fieldset>}

        {error && <p className="auth-notice" role="alert">{error}</p>}
        <button className="primary-button checkin-submit" disabled={sending || (hasMeds && !meds) || !weightValid} onClick={submit} type="button">
          {sending ? s.sending : s.submit}
        </button>
      </div>}
      <p className="checkin-note">{s.careTeam}</p>
    </section>
  )
}

/** 30 squares, one per day: filled for a check-in, tinted by that day's worst flag. */
export function CheckInDots({ followUp, label }: { followUp: FollowUp; label: string }) {
  const byDay = new Map(followUp.timeline.map(d => [d.day, d.level]))
  return (
    <div className="checkin-dots-wrap">
      <ol aria-label={label} className="checkin-dots">
        {Array.from({ length: 30 }, (_, i) => i + 1).map(d => (
          <li className={`checkin-dot ${byDay.has(d) ? `is-${byDay.get(d)}` : d < followUp.day ? "is-missed" : d === followUp.day ? "is-today" : ""}`} key={d} title={`Day ${d}`} />
        ))}
      </ol>
      <span className="checkin-dots-label">{label}</span>
    </div>
  )
}
