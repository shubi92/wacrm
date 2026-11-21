'use client'

// The furniture-moving form as the customer sees it: four steps and a
// "received" screen, drawn from the one definition the server also
// checks the answers against (`@/lib/whatsapp/forms/furniture-moving`).
// What this page checks is for the customer's convenience only; the
// server checks everything again.

import Image from 'next/image'
import { useRef, useState, useSyncExternalStore } from 'react'
import {
  FIELD_ERRORS,
  MAX_COUNT,
  MAX_TEXT,
  MOVING_BRAND,
  MOVING_DEFAULTS,
  MOVING_SCREENS,
  MOVING_TEXT,
  YES_NO,
  itemsChosen,
  readMovingAnswers,
  shows,
  type Field,
  type FieldError,
  type FormLang,
  type MovingValues,
  type Option,
} from '@/lib/whatsapp/forms/furniture-moving'
import { Gone } from './gone'

type Errors = Record<string, FieldError>
type Asked = Exclude<Field, { t: 'section' | 'group' }>

/** Every field that takes an answer, with the step it is on. */
const ASKED: { field: Asked; step: number }[] = []
const walk = (fields: Field[], step: number) => {
  for (const f of fields) {
    if (f.t === 'section') walk(f.fields, step)
    else if (f.t === 'group') {
      if (f.after) ASKED.push({ field: f.after, step })
    } else ASKED.push({ field: f, step })
  }
}
MOVING_SCREENS.forEach((screen, step) => walk(screen.fields, step))

/** Today on the customer's phone, YYYY-MM-DD. Empty on the server,
 *  whose "today" may be another day. */
const localToday = () => {
  const d = new Date()
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
  return d.toISOString().slice(0, 10)
}
const never = () => () => {}

/** What is missing or wrong on one step. */
function checkStep(step: number, v: MovingValues, today: string): Errors {
  const errors: Errors = {}
  for (const { field: f, step: s } of ASKED) {
    if (s !== step) continue
    const value = v[f.id]
    if (f.t === 'text' && !String(value ?? '').trim()) errors[f.id] = 'required'
    if (f.t === 'chips' && !f.optional && value === undefined) errors[f.id] = 'choose'
    if (f.t === 'date') {
      if (!value) errors[f.id] = 'required'
      else if (today && String(value) < today) errors[f.id] = 'past'
    }
  }
  return errors
}

const Plus = ({ withBar = true }: { withBar?: boolean }) => (
  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
    <path d={withBar ? 'M12 6v12M6 12h12' : 'M6 12h12'} />
  </svg>
)
const MOVE_ICONS: Record<string, React.ReactNode> = {
  within: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 21V8l7-4v17M11 21V11l9 3v7M2 21h20M7 10v.01M7 14v.01M7 18v.01M15 17v.01" />
    </svg>
  ),
  between: (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="2.6" />
      <circle cx="19" cy="12" r="2.6" />
      <path d="M9.6 12h4.8" strokeDasharray="0.1 2.3" />
    </svg>
  ),
}

export function MovingForm({
  token,
  lang: firstLang,
  sent: alreadySent,
}: {
  token: string
  lang: FormLang
  /** The answers, when this link was already sent. */
  sent: Record<string, unknown> | null
}) {
  const [lang, setLang] = useState<FormLang>(firstLang)
  const [step, setStep] = useState(0)
  const [v, setV] = useState<MovingValues>(
    alreadySent ? (alreadySent as MovingValues) : MOVING_DEFAULTS,
  )
  const [errors, setErrors] = useState<Errors>({})
  const [sent, setSent] = useState(!!alreadySent)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [gone, setGone] = useState(false)
  const today = useSyncExternalStore(never, localToday, () => '')
  const shell = useRef<HTMLDivElement>(null)
  const busy = useRef(false)

  const t = (l: Record<FormLang, string>) => l[lang]
  const set = (id: string, value: string | number | undefined) => {
    setV((old) => ({ ...old, [id]: value }))
    setErrors((old) => {
      if (!(id in old)) return old
      const rest = { ...old }
      delete rest[id]
      return rest
    })
  }

  /** Bring the first field with a problem into view, once it is drawn. */
  const showFirstError = () =>
    requestAnimationFrame(() => {
      const bad = shell.current?.querySelector<HTMLElement>('.bad')
      if (!bad) return
      bad.scrollIntoView({ block: 'center', behavior: 'smooth' })
      bad.querySelector<HTMLElement>('input,select,textarea,button')?.focus({ preventScroll: true })
    })

  const goTo = (n: number) => {
    setStep(n)
    window.scrollTo(0, 0)
  }

  async function send() {
    // Two taps can land before the button is drawn as disabled.
    if (busy.current) return
    busy.current = true
    setSending(true)
    setFailed(false)
    try {
      const res = await fetch(`/api/forms/${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...v, lang }),
      })
      if (res.ok) {
        setSent(true)
        window.scrollTo(0, 0)
      } else if (res.status === 410) {
        setGone(true)
      } else if (res.status === 422) {
        // The server turned an answer down: show it where it was asked.
        const fields = ((await res.json()) as { fields?: Errors }).fields ?? {}
        const steps = ASKED.filter(({ field }) => field.id in fields).map((a) => a.step)
        if (!steps.length) return setFailed(true)
        setErrors(fields)
        setStep(Math.min(...steps))
        showFirstError()
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    } finally {
      busy.current = false
      setSending(false)
    }
  }

  function next() {
    const found = checkStep(step, v, today)
    if (Object.keys(found).length) {
      setErrors(found)
      showFirstError()
    } else if (step < MOVING_SCREENS.length - 1) {
      goTo(step + 1)
    } else {
      void send()
    }
  }

  if (gone) return <Gone />

  const label = (f: { label: Record<FormLang, string> }, optional = false) => (
    <>
      {t(f.label)}
      {optional && <span className="opt"> ({t(MOVING_TEXT.optional)})</span>}
    </>
  )
  const error = (id: string) =>
    errors[id] && (
      <p className="err" id={`e_${id}`}>
        {t(FIELD_ERRORS[errors[id]])}
      </p>
    )
  const bad = (id: string) => (errors[id] ? ' bad' : '')
  const described = (id: string) => (errors[id] ? `e_${id}` : undefined)

  const chips = (id: string, options: Option[], clearable = false) => (
    <div className="chips">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          aria-pressed={v[id] === o.id}
          aria-describedby={described(id)}
          onClick={() => set(id, clearable && v[id] === o.id ? undefined : o.id)}
        >
          {t(o.short ?? o.label)}
        </button>
      ))}
    </div>
  )

  const stepper = (item: Option) => {
    const n = Number(v[item.id] ?? 0)
    const name = t(item.label)
    return (
      <div className={`row${n ? ' has' : ''}`} key={item.id}>
        <span className="name">{name}</span>
        <div className={`stp${n ? '' : ' zero'}`}>
          <button
            type="button"
            className="dec"
            aria-label={t(MOVING_TEXT.less) + name}
            onClick={(e) => {
              // At 0 this button goes away: keep the focus on the row.
              if (n === 1) (e.currentTarget.parentElement?.querySelector('.inc') as HTMLElement | null)?.focus()
              set(item.id, Math.max(0, n - 1))
            }}
          >
            <Plus withBar={false} />
          </button>
          <output aria-live="polite">{n}</output>
          <button
            type="button"
            className="inc"
            aria-label={t(MOVING_TEXT.more) + name}
            disabled={n >= MAX_COUNT}
            onClick={() => set(item.id, Math.min(MAX_COUNT, n + 1))}
          >
            <Plus />
          </button>
        </div>
      </div>
    )
  }

  const yesNo = (f: Extract<Field, { t: 'yesno' }>) => (
    <div className="yn" role="group" aria-label={t(f.label)} key={f.id}>
      <span className="lbl">{t(f.label)}</span>
      {chips(f.id, YES_NO)}
    </div>
  )

  const draw = (f: Field, i: number): React.ReactNode => {
    switch (f.t) {
      case 'section':
        return (
          <section className="card" key={i}>
            <h2>{t(f.title)}</h2>
            {f.fields.map(draw)}
          </section>
        )
      case 'group':
        return (
          <div key={i} style={{ display: 'contents' }}>
            <h2 className="sec-title">{t(f.title)}</h2>
            <section className="card list">{f.items.map(stepper)}</section>
            {f.after && shows(f.after.when, v) && <section className="card">{yesNo(f.after)}</section>}
          </div>
        )
      case 'cards':
        return (
          <fieldset className="fld" key={f.id}>
            <legend>{label(f)}</legend>
            <div className="cards">
              {f.options.map((o) => (
                <button key={o.id} type="button" aria-pressed={v[f.id] === o.id} onClick={() => set(f.id, o.id)}>
                  {MOVE_ICONS[o.id]}
                  <b>{t(o.label)}</b>
                  {o.hint && <small>{t(o.hint)}</small>}
                </button>
              ))}
            </div>
          </fieldset>
        )
      case 'chips':
        return (
          <fieldset className={`fld${bad(f.id)}`} key={f.id}>
            <legend>{label(f, f.optional)}</legend>
            {chips(f.id, f.options, f.optional)}
            {error(f.id)}
          </fieldset>
        )
      case 'yesno':
        return shows(f.when, v) ? yesNo(f) : null
      case 'select':
        return shows(f.when, v) ? (
          <div className="fld" key={f.id}>
            <label htmlFor={`f_${f.id}`}>{label(f)}</label>
            <select id={`f_${f.id}`} value={String(v[f.id] ?? '')} onChange={(e) => set(f.id, e.target.value)}>
              {f.options.map((o) => (
                <option key={o.id} value={o.id}>
                  {t(o.label)}
                </option>
              ))}
            </select>
          </div>
        ) : null
      case 'text':
        return (
          <div className={`fld${bad(f.id)}`} key={f.id}>
            <label htmlFor={`f_${f.id}`}>{label(f)}</label>
            <input
              type="text"
              id={`f_${f.id}`}
              dir="auto"
              value={String(v[f.id] ?? '')}
              placeholder={f.placeholder && t(f.placeholder)}
              maxLength={MAX_TEXT}
              autoComplete={f.id === 'name' ? 'name' : 'off'}
              aria-invalid={!!errors[f.id]}
              aria-describedby={described(f.id)}
              onChange={(e) => set(f.id, e.target.value)}
            />
            {error(f.id)}
          </div>
        )
      case 'date':
        return (
          <div className={`fld${bad(f.id)}`} key={f.id}>
            <label htmlFor={`f_${f.id}`}>{label(f)}</label>
            <input
              type="date"
              id={`f_${f.id}`}
              min={today || undefined}
              value={String(v[f.id] ?? '')}
              aria-invalid={!!errors[f.id]}
              aria-describedby={described(f.id)}
              onChange={(e) => set(f.id, e.target.value)}
            />
            {error(f.id)}
          </div>
        )
      case 'area':
        return (
          <div className={`fld${bad(f.id)}`} key={f.id}>
            <label htmlFor={`f_${f.id}`}>{label(f, true)}</label>
            <textarea
              id={`f_${f.id}`}
              dir="auto"
              rows={3}
              value={String(v[f.id] ?? '')}
              placeholder={f.placeholder && t(f.placeholder)}
              maxLength={MAX_TEXT}
              aria-describedby={described(f.id)}
              onChange={(e) => set(f.id, e.target.value)}
            />
            {error(f.id)}
          </div>
        )
    }
  }

  const screen = MOVING_SCREENS[step]
  const name = String(v.name ?? '').trim()
  const last = step === MOVING_SCREENS.length - 1

  return (
    <div className="shell" ref={shell} dir={lang === 'ar' ? 'rtl' : 'ltr'} lang={lang}>
      <header className="top">
        <div className="top-row">
          <div className="mark">
            <Image src={MOVING_BRAND.logo} alt="" width={92} height={72} priority />
          </div>
          <div className="brand">
            <b>{t(MOVING_BRAND.name)}</b>
            <span>{t(MOVING_BRAND.form)}</span>
          </div>
          <button
            type="button"
            className="lang"
            lang={lang === 'ar' ? 'en' : 'ar'}
            onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')}
          >
            {t(MOVING_TEXT.otherLang)}
          </button>
        </div>
        <div className="bars" aria-hidden="true">
          {MOVING_SCREENS.map((_, i) => (
            <i key={i} className={sent || i <= step ? 'on' : ''} />
          ))}
        </div>
      </header>

      {sent ? (
        <main className="body">
          <div className="done">
            <div className="tick">
              <svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M5 12.5l4.5 4.5L19 7.5" />
              </svg>
            </div>
            <h1>
              {t(MOVING_TEXT.doneTitle)}
              {name && (lang === 'ar' ? '، ' : ', ') + name}
            </h1>
            <p>{t(MOVING_TEXT.doneText)}</p>
          </div>
          <section className="card">
            <h2>{t(MOVING_TEXT.summary)}</h2>
            <dl className="sum">
              {readMovingAnswers(v, lang).rows.map((r) => (
                <div key={r.label} style={{ display: 'contents' }}>
                  <dt>{r.label}</dt>
                  <dd>{r.value}</dd>
                </div>
              ))}
            </dl>
          </section>
          <div className="actions">
            <a className="btn primary" href={MOVING_BRAND.whatsapp}>
              {t(MOVING_TEXT.toWhatsApp)}
            </a>
          </div>
        </main>
      ) : (
        <>
          <main className="body">
            <p className="step-no">{t(MOVING_TEXT.step).replace('{n}', String(step + 1))}</p>
            <h1>{t(screen.title)}</h1>
            {screen.help && <p className="help">{t(screen.help)}</p>}
            {screen.fields.map(draw)}
          </main>
          <footer className="foot">
            {screen.counted && <p className="count">{t(MOVING_TEXT.count) + itemsChosen(v)}</p>}
            {failed && (
              <p className="err" role="alert">
                {t(MOVING_TEXT.failed)}
              </p>
            )}
            <div className="nav">
              {step > 0 && (
                <button type="button" className="btn" disabled={sending} onClick={() => goTo(step - 1)}>
                  {t(MOVING_TEXT.back)}
                </button>
              )}
              <button type="button" className="btn primary" disabled={sending} onClick={next}>
                {t(sending ? MOVING_TEXT.sending : last ? MOVING_TEXT.send : MOVING_TEXT.next)}
              </button>
            </div>
          </footer>
        </>
      )}
    </div>
  )
}

