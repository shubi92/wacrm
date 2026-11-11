import type { ChatMessage } from './types'
import type { HandoffLead } from './lead'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * What the customer is told when the bot hands off without a message of
 * its own — a handoff must never be met with silence. Arabic when the
 * customer wrote in Arabic script, English otherwise.
 * ponytail: two fixed lines; move to ai_configs if an account needs its
 * own wording.
 */
export function handoffFallbackMessage(lastCustomerText: string): string {
  return /[\u0600-\u06FF]/.test(lastCustomerText)
    ? 'تم تحويل طلبك إلى فريقنا وسيتواصلون معك قريباً.'
    : 'Your request has been passed to our team and they will contact you shortly.'
}

/**
 * Build the short internal note the auto-reply bot leaves on a
 * conversation when it hands off to a human. Deterministic — composed
 * from context we already have (no extra LLM call / token spend), so it
 * can't fail or add latency to the handoff.
 *
 * Reads as, e.g.:
 *   "🤖 AI agent handed off after 2 replies. Last customer message:
 *    “can I speak to a manager about my refund?”"
 *
 * `replyCount` is the bot's auto-reply tally for the thread (0 when it
 * bailed on the very first inbound without answering).
 */
export function buildHandoffSummary(args: {
  messages: ChatMessage[]
  replyCount: number
  /** Set when the customer said yes — the note then leads with it, so
   *  the details survive in the inbox even if a webhook delivery fails. */
  lead?: HandoffLead | null
  /** The bot wrote lead details that could not be read. */
  leadUnreadable?: boolean
  /** The model did not ask to hand off — its answer just wasn't in a
   *  form that may be sent. Said in the note, since it means a fault,
   *  not a decision. */
  unsendable?: boolean
}): string {
  const { messages, replyCount, lead, leadUnreadable, unsendable } = args

  const lastCustomer = [...messages]
    .reverse()
    .find((m) => m.role === 'user' && m.content.trim())

  const replies =
    replyCount === 0
      ? 'without replying'
      : `after ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`

  let base = `🤖 AI agent handed off ${replies}.`
  if (lead) {
    const facts = [
      lead.service.replace(/_/g, ' '),
      lead.quoted_price_sar !== null && `quoted ${lead.quoted_price_sar} SAR`,
      lead.customer_name,
      lead.area,
      lead.preferred_date,
    ].filter(Boolean)
    base += ` Customer is ready: ${facts.join(', ')}.`
  } else if (leadUnreadable) {
    base += ' The customer looks ready to book, but the details could not be read — please check the chat.'
  } else if (unsendable) {
    base += ' The bot did not choose this: its answer was empty or not in a form that can be sent.'
  }

  if (!lastCustomer) return base

  const quote = truncate(lastCustomer.content.trim(), MAX_QUOTE_LEN)
  return `${base} Last customer message: “${quote}”`
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ')
  if (collapsed.length <= max) return collapsed
  return `${collapsed.slice(0, max - 1).trimEnd()}…`
}
