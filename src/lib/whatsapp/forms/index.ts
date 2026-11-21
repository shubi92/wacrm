// ============================================================
// Forms the AI agent can send: a web page of our own that the customer
// opens from a link button in the WhatsApp chat.
//
// Out:  the bot writes `[[FORM:<name>]]` after its reply; its line goes
//       out with an "Open form" button whose link holds a one-time
//       token (./links) and opens /form/<token>.
// Back: the page posts the answers to /api/forms/<token>; ./submit
//       checks them, stores them as one message in the chat, and the
//       bot thanks the customer and hands the chat over.
//
// Add a form: its definition file + one entry in `BOT_FORMS`, and its
// page under /form/[token].
// ============================================================

import type { HandoffLead } from '@/lib/ai/lead'
import {
  MOVING_FORM,
  readMovingAnswers,
  validateMovingAnswers,
  type FieldError,
  type FormLang,
} from './furniture-moving'

/** A submitted form, ready for the inbox and the handoff. */
export interface FormSubmission {
  form: string
  /** What the inbox shows for the customer's answers. */
  text: string
  /** Sent to the customer in the chat once the answers are in. */
  thankYou: string
  /** The internal handoff note. */
  note: string
  lead: HandoffLead
}

interface BotForm {
  /** Label of the button that opens the form (Meta allows 20 characters). */
  button: Record<FormLang, string>
  /** Check what the browser sent; only clean answers come back. */
  validate: (
    raw: unknown,
  ) => { ok: true; answers: Record<string, unknown> } | { ok: false; fields: Record<string, FieldError> }
  /** Clean answers → what the team and the customer are told. */
  read: (answers: Record<string, unknown>) => FormSubmission
}

/** Forms the bot may send. */
export const BOT_FORMS: Record<string, BotForm> = {
  [MOVING_FORM]: {
    button: { en: 'Open form', ar: 'افتح النموذج' },
    validate: validateMovingAnswers,
    read: (answers) => {
      const a = readMovingAnswers(answers)
      const facts = ['furniture moving', a.name, a.area, a.date].filter(Boolean).join(', ')
      return {
        form: MOVING_FORM,
        text: ['📋 Furniture moving form', ...a.rows.map((r) => `${r.label}: ${r.value}`)].join('\n'),
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
      }
    },
  },
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

/** Arabic script in the bot's line → the form opens in Arabic. */
export const formLang = (replyText: string): FormLang =>
  /[؀-ۿ]/.test(replyText) ? 'ar' : 'en'
