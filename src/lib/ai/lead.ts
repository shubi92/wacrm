// ============================================================
// The lead block: what the bot collected from the customer.
//
// Whenever the auto-reply bot hands a chat over and knows something
// about what the customer wants, it adds, OUTSIDE its <reply> tags:
//
//   <lead>{ "ready": true, "service": "...", "details": [...], ... }</lead>
//
// `ready` says whether the customer said yes; it decides the handoff's
// `reason` and is not part of the lead itself. `parseGeneration` reads
// the block; the lead rides on the `conversation.handed_off` webhook as
// `data.lead`. That shape is a public contract (see docs/public-api.md)
// — change it only together with its consumers.
// ============================================================

export const LEAD_SERVICES = [
  'ac_cleaning',
  'pest_control',
  'kitchen_bathroom_cleaning',
  'apartment_cleaning',
  'villa_cleaning',
  'steam_cleaning',
  'floor_polishing',
  'furniture_moving',
  'other',
] as const

export type LeadService = (typeof LEAD_SERVICES)[number]

export interface HandoffLead {
  service: LeadService
  /** What the bot collected, in the customer's language. */
  details: { question: string; answer: string }[]
  /** Only when the bot actually quoted a price. */
  quoted_price_sar: number | null
  customer_name: string | null
  /** City / district as the customer said it. */
  area: string | null
  /** Free text as the customer said it. */
  preferred_date: string | null
}

// Tags are matched loosely (case, spaces, stray attributes): a block the
// model wrote slightly wrong must still never reach the customer.
const OPEN = String.raw`<\s*lead(?:\s[^>]*)?>`
const CLOSE = String.raw`<\s*\/\s*lead\s*>`
const block = () => new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`, 'gi')
/** `<lead></lead>`, `<lead>null</lead>`: a model's way of saying "no
 *  lead this turn" (as is an object with nothing in it, see `read`). */
const BLANK = /^\s*(?:null|none)?\s*$/i
const MAX_DETAILS = 30
const MAX_TEXT = 300

/** True when the text carries any lead tag, opening or closing. */
export function hasLeadTag(text: string): boolean {
  return new RegExp(`${OPEN}|${CLOSE}`, 'i').test(text)
}

/**
 * Swap every complete lead block for `mark` (empty ones for nothing), so
 * nothing inside a block — a `<reply>` or `[[HANDOFF]]` a customer typed
 * and the model copied into the details — can be mistaken for the bot's
 * own output, while the block's position stays known.
 */
export function maskLeadBlocks(text: string, mark: string): string {
  return text.replace(block(), (_m, inner: string) => (read(inner) === undefined ? '' : mark))
}

/**
 * Read the last complete lead block in the model's raw output: the lead,
 * and whether the customer said yes (`ready`). Returns null when there
 * is no block, it says nothing, or it is unusable (never closed — e.g.
 * cut off by the token limit — or not a JSON object). Individual fields
 * that don't fit the contract are dropped to null / "other" rather than
 * failing the whole block: a usable lead beats a perfect one.
 */
export function parseLeadBlock(raw: string): ParsedLead | null {
  const inner = [...raw.matchAll(block())].at(-1)?.[1]
  return (inner === undefined ? null : read(inner)) ?? null
}

export interface ParsedLead {
  lead: HandoffLead
  /** The customer clearly said yes. Anything but a plain `true` is no. */
  ready: boolean
}

/** One block's content → the lead, `null` when it can't be read, or
 *  `undefined` when it says nothing (not a lead, and not a handoff). */
function read(inner: string): ParsedLead | null | undefined {
  if (BLANK.test(inner)) return undefined

  // Models like to wrap the JSON in a markdown fence or a few words.
  // (A list is not a lead, even a list of one.)
  const start = inner.indexOf('{')
  if (start === -1 || inner.slice(0, start).includes('[')) return null
  const json = inner.slice(start, inner.lastIndexOf('}') + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const o = parsed as Record<string, unknown>

  const lead: HandoffLead = {
    service: (LEAD_SERVICES as readonly unknown[]).includes(o.service)
      ? (o.service as LeadService)
      : 'other',
    details: (Array.isArray(o.details) ? o.details : [])
      .map((d) => ({
        question: text((d as Record<string, unknown> | null)?.question),
        answer: text((d as Record<string, unknown> | null)?.answer),
      }))
      .filter((d): d is { question: string; answer: string } => !!d.question && !!d.answer)
      .slice(0, MAX_DETAILS),
    quoted_price_sar: price(o.quoted_price_sar),
    customer_name: text(o.customer_name),
    area: text(o.area),
    preferred_date: text(o.preferred_date),
  }
  const ready = o.ready === true || o.ready === 'true'
  // An object that tells us nothing ("{}", all nulls) is not a lead. A
  // yes always is: `customer_ready` never travels without one.
  const says =
    ready ||
    lead.service !== 'other' ||
    lead.details.length > 0 ||
    lead.quoted_price_sar !== null ||
    lead.customer_name ||
    lead.area ||
    lead.preferred_date
  return says ? { lead, ready } : undefined
}

/** A non-empty trimmed string (numbers and yes/no flags allowed), or null. */
function text(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null
  // Cut by code point, so an emoji is never split into a broken half.
  const s = [...String(v).trim()].slice(0, MAX_TEXT).join('')
  return s || null
}

/** A positive number. Also accepts it as a string, the way a model may
 *  echo the customer: "300", "1,200", "٣٠٠", "300 ريال". Anything with
 *  more than one number in it ("300-400") is not a quote. */
function price(v: unknown): number | null {
  if (typeof v === 'string') {
    const s = v
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[,٬]/g, '')
    const m = /^[^\d-]*(\d+(?:\.\d+)?)\D*$/.exec(s)
    v = m ? Number(m[1]) : null
  }
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}
