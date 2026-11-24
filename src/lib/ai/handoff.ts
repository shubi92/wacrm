import type { ChatMessage } from './types'
import type { HandoffLead } from './lead'

/** Longest the quoted customer message runs before we ellipsize it —
 *  keeps the internal note to a glanceable one-liner. */
const MAX_QUOTE_LEN = 160

/**
 * What the customer is told when the bot hands off without a message of
 * its own — a handoff must never be met with silence. Arabic or English
 * by `isEnglish`.
 * ponytail: two fixed lines; move to ai_configs if an account needs its
 * own wording.
 */
export function handoffFallbackMessage(lastCustomerText: string): string {
  return isEnglish(lastCustomerText)
    ? 'Your request has been passed to our team and they will contact you shortly.'
    : 'تم تحويل طلبك إلى فريقنا وسيتواصلون معك قريباً.'
}

const WAITING_AR = 'وصلت رسالتك 🌿 محادثتك الآن عند فريق المبيعات، وبيرد عليك أحد الزملاء في أقرب وقت.'
const WAITING_EN =
  'We got your message. Your chat is now with our sales team, and one of them will reply as soon as possible.'

/**
 * What a customer who writes again after a handoff, before anyone has
 * answered, is told: the chat is with the sales team. Fixed text, never
 * a fresh answer. Same language rule as `handoffFallbackMessage`.
 */
export function waitingMessage(lastCustomerText: string): string {
  return isEnglish(lastCustomerText) ? WAITING_EN : WAITING_AR
}

/** True for a message the bot sent with `waitingMessage`. */
export function isWaitingMessage(text: string | null | undefined): boolean {
  return text === WAITING_AR || text === WAITING_EN
}

/** A video, photo or file the customer sent — the bot can't open it. */
export interface InboundMedia {
  kind: 'video' | 'image' | 'document'
  /** What the customer typed under it, if anything. */
  caption?: string
}

/** What a customer who sends one is told, per kind. */
const MEDIA_LINES: Record<InboundMedia['kind'], { name: string; ar: string; en: string }> = {
  video: {
    name: 'video',
    ar: 'وصلني المقطع 🌿 بيشوفه أحد الزملاء من فريق المبيعات. ولين يرد عليك، قل لي وش الخدمة اللي تحتاجها وأنا أخدمك.',
    en: "Got your video. A colleague from our sales team will take a look. Meanwhile, tell me which service you need and I'll help.",
  },
  image: {
    name: 'photo',
    ar: 'وصلتني الصورة 🌿 بيشوفها أحد الزملاء من فريق المبيعات. ولين يرد عليك، قل لي وش الخدمة اللي تحتاجها وأنا أخدمك.',
    en: "Got your photo. A colleague from our sales team will take a look. Meanwhile, tell me which service you need and I'll help.",
  },
  document: {
    name: 'file',
    ar: 'وصلني الملف 🌿 بيشوفه أحد الزملاء من فريق المبيعات. ولين يرد عليك، قل لي وش الخدمة اللي تحتاجها وأنا أخدمك.',
    en: "Got your file. A colleague from our sales team will take a look. Meanwhile, tell me which service you need and I'll help.",
  },
}

/** Same language rule as `waitingMessage`. */
export function mediaMessage(kind: InboundMedia['kind'], lastCustomerText: string): string {
  return isEnglish(lastCustomerText) ? MEDIA_LINES[kind].en : MEDIA_LINES[kind].ar
}

/** Language of the bot's fixed lines: English only for Latin letters with
 *  no Arabic. A number, "؟", an emoji or nothing says nothing: Arabic. */
function isEnglish(text: string): boolean {
  return /\p{Script=Latin}/u.test(text) && !isArabic(text)
}

/** True when the text has any Arabic script in it. */
export function isArabic(text: string): boolean {
  return /[\u0600-\u06FF]/.test(text)
}

/** Every note the bot leaves when it hands a chat off starts with this.
 *  A person's pause writes no note, and Resume AI clears it. */
const BOT_HANDOFF_NOTE = '🤖 AI agent handed off'

/** True when the chat's pause is one the bot made by handing off. */
export function isBotHandoffSummary(summary: string | null | undefined): boolean {
  return !!summary?.startsWith(BOT_HANDOFF_NOTE)
}

const REPLY_CAP_NOTE = `${BOT_HANDOFF_NOTE}: it reached its limit of `

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

const MEDIA_NOTE = `${BOT_HANDOFF_NOTE} one thing only: `

/** What the note says the customer sent, e.g. to add to the cap's note. */
export function mediaReceivedNote(kind: InboundMedia['kind']): string {
  return `The customer sent a ${MEDIA_LINES[kind].name} that needs a look.`
}

/**
 * The internal note for media the bot can't open. The model reads it too
 * (`handedOff` in `buildSystemPrompt`), so it says that only the looking
 * was handed off — everything else is still the bot's.
 */
export function mediaSummary(kind: InboundMedia['kind']): string {
  return (
    `${MEDIA_NOTE}looking at a ${MEDIA_LINES[kind].name}. ${mediaReceivedNote(kind)} ` +
    'Nothing else was handed off: the service they need, prices, booking, and whatever they were already discussing with the bot are separate requests that the bot still answers.'
  )
}

/** True when the chat's pause is only the flag `mediaSummary` describes. */
export function isMediaSummary(summary: string | null | undefined): boolean {
  return !!summary?.startsWith(MEDIA_NOTE)
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
