// ============================================================
// Auto-reply test numbers: while an account trials the bot on real
// WhatsApp, it only answers the phones listed here.
// ============================================================

/**
 * Canonical digits for comparing phones typed by an admin with the
 * E.164-ish numbers stored on contacts. Strips everything but digits and
 * a leading international "00". A bare local Saudi mobile (05XXXXXXXX)
 * becomes 9665XXXXXXXX so "0501234567" and "+966 50 123 4567" match.
 */
export function normalizePhone(raw: string): string {
  let d = raw.replace(/\D/g, '')
  if (d.startsWith('00')) d = d.slice(2)
  if (/^05\d{8}$/.test(d)) d = `966${d.slice(1)}`
  return d
}

/** Parse the settings textarea (one per line, or comma-separated). */
export function parseTestNumbers(input: unknown): string[] {
  const parts = Array.isArray(input)
    ? input.filter((x): x is string => typeof x === 'string')
    : typeof input === 'string'
      ? input.split(/[\n,]+/)
      : []
  const out = new Set<string>()
  for (const p of parts) {
    const n = normalizePhone(p)
    if (n.length >= 8) out.add(n)
  }
  return [...out]
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
