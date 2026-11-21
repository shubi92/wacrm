import { after, NextResponse } from 'next/server'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { hashToken, isToken } from '@/lib/whatsapp/forms/links'
import { submitForm } from '@/lib/whatsapp/forms/submit'

// POST /api/forms/<token> — a customer sends a form they opened from
// the chat. Public: no sign-in, the token in the address is the only
// key. The body is checked field by field in `submitForm`.

/** The whole form is a few hundred bytes of ids and numbers plus three
 *  short texts; this leaves room for long Arabic notes. */
const MAX_BODY_BYTES = 16 * 1024

/** Read the body, giving up as soon as it is larger than allowed. */
async function readCapped(request: Request): Promise<string | null> {
  if (Number(request.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return null
  const reader = request.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES) {
      await reader.cancel()
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  // Before anything is stored under it as a rate-limit key.
  if (!isToken(token)) return NextResponse.json({ error: 'gone' }, { status: 410 })

  // The address is whatever the proxy in front of the app reports (as
  // for the invite endpoints). With none there is nothing to tell
  // callers apart by, and one shared bucket would lock every customer
  // out together, so only the per-link limit applies.
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
  for (const result of [
    ip ? checkRateLimit(`form:ip:${ip.slice(0, 64)}`, RATE_LIMITS.formSubmitIp) : null,
    checkRateLimit(`form:token:${hashToken(token)}`, RATE_LIMITS.formSubmitToken),
  ]) {
    if (result && !result.success) return rateLimitResponse(result)
  }

  const body = await readCapped(request)
  if (body === null) return NextResponse.json({ error: 'too_large' }, { status: 413 })
  let raw: unknown
  try {
    raw = JSON.parse(body)
  } catch {
    return NextResponse.json({ error: 'bad_json' }, { status: 400 })
  }

  try {
    const result = await submitForm(token, raw)
    switch (result.status) {
      case 'accepted':
        // The thank-you and the handoff run after the customer has
        // their answer; `after` keeps the function alive for them.
        after(result.followUp)
        return NextResponse.json({ status: 'received' })
      case 'already':
        return NextResponse.json({ status: 'received' })
      case 'gone':
        return NextResponse.json({ error: 'gone' }, { status: 410 })
      case 'invalid':
        return NextResponse.json({ error: 'invalid', fields: result.fields }, { status: 422 })
    }
  } catch (err) {
    console.error('[forms] submit failed:', err)
    return NextResponse.json({ error: 'server_error' }, { status: 500 })
  }
}
