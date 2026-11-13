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

const REPLY_CAP_NOTE = '🤖 AI agent handed off: it reached its limit of '

/** The internal note for a handoff that only the reply cap caused. */
export function replyCapSummary(maxReplies: number): string {
  return `${REPLY_CAP_NOTE}${maxReplies} replies on this chat. Please take over.`
}

/**
 * True when a conversation's handoff note is the reply cap's — the one
 * pause the bot lifts by itself after a quiet day.
 * ponytail: recognised by its note, which only the bot writes and only
 * "Resume AI" clears. Add an `ai_handoff_reason` column when a second
 * handoff reason needs its own automatic behaviour.
 */
export function isReplyCapSummary(summary: string | null | undefined): boolean {
  return !!summary?.startsWith(REPLY_CAP_NOTE)
}

/**
 * The internal note left when a connected system pauses the bot through
 * `POST /api/v1/conversations/{id}/ai-pause`. Not the reply cap's note,
 * so the quiet-day reset treats it as a person's pause and leaves it.
 */
export const API_PAUSE_NOTE =
  '⏸ AI agent paused by a connected system (API). Resume AI hands the chat back to the bot.'

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
  /** What the bot collected — the note carries the key facts, so they
   *  survive in the inbox even if a webhook delivery fails. */
  lead?: HandoffLead | null
  /** The customer said yes. */
  ready?: boolean
  /** The bot wrote lead details that could not be read. */
  leadUnreadable?: boolean
  /** The model did not ask to hand off — its answer just wasn't in a
   *  form that may be sent. The note says so and quotes what it wrote,
   *  since that is a fault to look into, not a decision. */
  unsendable?: { raw: string; retried: boolean }
}): string {
  const { messages, replyCount, lead, ready, leadUnreadable, unsendable } = args

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
    base += ` ${ready ? 'Customer is ready' : 'Collected so far'}: ${facts.join(', ')}.`
  } else if (leadUnreadable) {
    base += ' The bot tried to pass on what it collected, but the details could not be read — please check the chat.'
  } else if (unsendable) {
    base +=
      ` The bot did not choose this: its answer could not be sent (no complete <reply> block)${unsendable.retried ? ', even on a second try' : ''}.` +
      ` It wrote: “${truncate(unsendable.raw, MAX_QUOTE_LEN)}”`
  } else {
    base += ' The bot chose to hand off.'
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
