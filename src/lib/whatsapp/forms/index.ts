// ============================================================
// WhatsApp forms (Meta "WhatsApp Flows") the AI agent can send, and
// reading what the customer sends back.
//
// Out:  the bot writes `[[FORM:<name>]]` after its reply; we send the
//       Flow named `<name>_ar` or `<name>_en` (as published in WhatsApp
//       Manager) with the reply as the message and an "Open form" button.
// Back: one `interactive.nfm_reply` message whose `response_json` holds
//       every answer. Meta does not say which Flow it came from, so the
//       form names itself in its own payload (`form`, `lang`).
//
// Add a form: its definition file + one entry in `read` and `BOT_FORMS`.
// ============================================================

import type { HandoffLead } from '@/lib/ai/lead'
import { MOVING_FORM, readMovingAnswers, type FormLang } from './furniture-moving'

/** Forms the bot may send, with the label of the button that opens them. */
export const BOT_FORMS: Record<string, { button: Record<FormLang, string> }> = {
  [MOVING_FORM]: { button: { en: 'Open form', ar: 'افتح النموذج' } },
}

/** `[[FORM:furniture_moving]]` in the model's output. */
const FORM_MARKER = /\[\[\s*FORM\s*:\s*([a-z0-9_]+)\s*\]\]/gi
/** Anything shaped like a form marker, however the model mangled it
 *  (`[FORM:x]`, `[[FORM: x y]]`), and the history's own `[form sent]`. */
const FORM_LIKE = /\[{1,2}\s*FORM\b[^\]\n]{0,80}\]{1,2}/gi

/** Appended, in the bot's view of the chat, to a line of its own that
 *  went out with a form's button (see `buildConversationContext`). */
export const FORM_SENT_NOTE = '[form sent]'

/** An account switches forms on by naming one in its instructions. */
export const mentionsForms = (instructions: string | null | undefined): boolean =>
  /\[\[\s*FORM\s*:/i.test(instructions ?? '')

/** The form the model asked to send (null when none, or one we don't
 *  have), and its text with everything marker-like removed — a mangled
 *  marker must not reach the customer either. */
export function takeFormMarker(text: string): { form: string | null; text: string } {
  const names = [...text.matchAll(FORM_MARKER)].map((m) => m[1].toLowerCase())
  const form = names.find((n) => Object.hasOwn(BOT_FORMS, n)) ?? null
  return { form, text: text.replace(FORM_LIKE, '') }
}

/** Arabic script in the bot's line → the Arabic form. */
export const formLang = (replyText: string): FormLang =>
  /[؀-ۿ]/.test(replyText) ? 'ar' : 'en'

/** What goes to Meta for one form in one language. */
export function formMessage(form: string, lang: FormLang) {
  return {
    /** The Flow's name in WhatsApp Manager. */
    flowName: `${form}_${lang}`,
    buttonLabel: BOT_FORMS[form].button[lang],
    /** Comes back with the answers; a second way to tell the form. */
    flowToken: `${form}:${lang}`,
  }
}

/** A submitted form we know how to read. */
export interface FormSubmission {
  form: string
  /** Sent to the customer once the answers are in. */
  thankYou: string
  /** The internal handoff note. */
  note: string
  lead: HandoffLead
}

// The answers are customer-supplied: bound what an unknown form can
// put in the inbox.
const MAX_TEXT = 300
const MAX_LINES = 40

/**
 * Read a form reply. `text` is what the inbox shows for the message —
 * always something readable, even for a form we don't know.
 * `submission` is set only for a form we do know.
 */
export function readFormResponse(responseJson: unknown): {
  text: string
  submission: FormSubmission | null
} {
  // Customer-supplied data on the webhook path: whatever it holds, the
  // message must still be stored.
  try {
    return read(responseJson)
  } catch {
    return { text: UNREADABLE, submission: null }
  }
}

const UNREADABLE = '📋 Form response (could not be read)'

function read(responseJson: unknown): { text: string; submission: FormSubmission | null } {
  let answers: Record<string, unknown> | null = null
  try {
    const parsed = typeof responseJson === 'string' ? JSON.parse(responseJson) : responseJson
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      answers = parsed as Record<string, unknown>
    }
  } catch {
    // falls through: not JSON
  }
  if (!answers) return { text: UNREADABLE, submission: null }

  // The form's own `form` field, or the token we sent it with.
  const token = typeof answers.flow_token === 'string' ? answers.flow_token : ''
  const [tokenForm, tokenLang] = token.split(':')
  const form = typeof answers.form === 'string' ? answers.form : tokenForm

  if (form === MOVING_FORM) {
    const a = readMovingAnswers({ ...answers, lang: answers.lang ?? tokenLang })
    const facts = ['furniture moving', a.name, a.area, a.date].filter(Boolean).join(', ')
    return {
      text: ['📋 Furniture moving form', ...a.rows.map((r) => `${r.label}: ${r.value}`)].join('\n'),
      submission: {
        form,
        thankYou: a.thankYou,
        note: `🤖 AI agent handed off: the customer sent the furniture moving form. Customer is ready: ${facts}. The answers are in the chat.`,
        lead: {
          service: 'furniture_moving',
          details: a.rows.map((r) => ({ question: r.label, answer: r.value })),
          quoted_price_sar: null,
          customer_name: a.name,
          area: a.area,
          preferred_date: a.date,
        },
      },
    }
  }

  // A form this build does not know: show what came, as it came.
  const lines = Object.entries(answers)
    .filter(([key]) => key !== 'flow_token')
    .slice(0, MAX_LINES)
    .map(([key, value]) => {
      const shown = typeof value === 'string' ? value : JSON.stringify(value)
      return `${key.slice(0, 60)}: ${[...String(shown ?? '').slice(0, 4 * MAX_TEXT)].slice(0, MAX_TEXT).join('')}`
    })
  return { text: ['📋 Form response', ...lines].join('\n'), submission: null }
}
