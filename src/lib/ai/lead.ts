// ============================================================
// The "ready customer" block.
//
// When a customer says yes, the auto-reply bot hands the chat over and
// adds, OUTSIDE its <reply> tags, one block:
//
//   <lead>{ "service": "...", "details": [...], ... }</lead>
//
// `parseGeneration` reads it; it rides on the `conversation.handed_off`
// webhook as `data.lead`. The shape is a public contract (see
// docs/public-api.md) — change it only together with its consumers.
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
const MAX_DETAILS = 30
const MAX_TEXT = 300

/** True when the text carries a lead block, well-formed or not. */
export function hasLeadBlock(text: string): boolean {
  return new RegExp(OPEN, 'i').test(text)
}

/** Remove every lead block (and any stray tag) — for customer-visible text. */
export function stripLeadBlocks(text: string): string {
  return text
    .replace(new RegExp(`${OPEN}[\\s\\S]*?(?:${CLOSE}|$)`, 'gi'), '')
    .replace(new RegExp(CLOSE, 'gi'), '')
}

/**
 * Read the last complete lead block in the model's raw output. Returns
 * null when there is none or it is unusable (never closed — e.g. cut off
 * by the token limit — or not a JSON object). Individual fields that
 * don't fit the contract are dropped to null / "other" rather than
 * failing the whole block: a usable lead beats a perfect one.
 */
export function parseLeadBlock(raw: string): HandoffLead | null {
  const blocks = [...raw.matchAll(new RegExp(`${OPEN}([\\s\\S]*?)${CLOSE}`, 'gi'))]
  const inner = blocks.at(-1)?.[1]
  if (inner === undefined) return null

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

  return {
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
}

/** A non-empty trimmed string (numbers allowed, e.g. "3" units), or null. */
function text(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim().slice(0, MAX_TEXT)
  return s || null
}

/** A positive number. Also accepts it as a string, the way a model may
 *  echo the customer: "300", "1,200", "٣٠٠". */
function price(v: unknown): number | null {
  if (typeof v === 'string') {
    const s = v
      .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
      .replace(/[,٬\s]/g, '')
    v = /^\d+(\.\d+)?$/.test(s) ? Number(s) : null
  }
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}
