// ============================================================
// Auto-reply test numbers: while an account trials the bot on real
// WhatsApp, it only answers the phones listed here.
// ============================================================

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits → ASCII, so a number
 *  typed on an Arabic keyboard isn't stripped to nothing. */
function asciiDigits(s: string): string {
  return s.replace(/[٠-٩۰-۹]/g, (c) => {
    const code = c.charCodeAt(0)
    return String(code >= 0x06f0 ? code - 0x06f0 : code - 0x0660)
  })
}

/**
 * Canonical digits for comparing phones typed by an admin with the
 * E.164-ish numbers stored on contacts. Strips everything but digits and
 * a leading international "00". A bare local Saudi mobile (05XXXXXXXX)
 * becomes 9665XXXXXXXX so "0501234567" and "+966 50 123 4567" match.
 */
export function normalizePhone(raw: string): string {
  let d = asciiDigits(raw).replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (/^05\d{8}$/.test(d)) d = `966${d.slice(1)}`
  return d
}

export type TestNumbersParse =
  | { ok: true; numbers: string[] }
  | { ok: false; invalid: string[] }

/**
 * Parse the settings textarea (one per line, or comma-separated).
 * Every non-blank entry must be a plausible phone (8–15 digits after
 * normalizing). Anything else is rejected rather than dropped: a list
 * that silently became empty would mean "reply to everyone", the exact
 * opposite of what the admin asked for. Only a blank input (or an empty
 * array) is the explicit "no restriction".
 */
export function parseTestNumbers(input: unknown): TestNumbersParse {
  let parts: string[]
  if (Array.isArray(input)) {
    if (!input.every((x) => typeof x === 'string')) return { ok: false, invalid: ['(non-text entry)'] }
    parts = input as string[]
  } else if (typeof input === 'string') {
    parts = input.split(/[\n,،]+/)
  } else if (input === null) {
    parts = []
  } else {
    return { ok: false, invalid: ['(unsupported value)'] }
  }
  const numbers = new Set<string>()
  const invalid: string[] = []
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) continue
    const n = normalizePhone(p)
    if (/^\d{8,15}$/.test(n)) numbers.add(n)
    else invalid.push(p)
  }
  return invalid.length > 0 ? { ok: false, invalid } : { ok: true, numbers: [...numbers] }
}

/** Empty list = no restriction (the bot is live for everyone). */
export function isTestNumberAllowed(
  phone: string | null | undefined,
  testNumbers: string[] | null | undefined,
): boolean {
  if (!testNumbers || testNumbers.length === 0) return true
  if (!phone) return false
  const n = normalizePhone(phone)
  return testNumbers.some((t) => normalizePhone(t) === n)
}

/**
 * Will the auto-reply bot answer this contact? `null` test numbers means
 * the list couldn't be read (migration 038 missing / lookup failed); the
 * bot fails closed in that case, so this does too.
 */
export function botAnswersContact(
  phone: string | null | undefined,
  testNumbers: string[] | null,
): boolean {
  return testNumbers !== null && isTestNumberAllowed(phone, testNumbers)
}
