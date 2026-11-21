import { beforeEach, describe, expect, it, vi } from 'vitest'

// The public endpoint a customer's phone posts a form to. `submitForm`
// (the checking and storing) has its own tests; here: what reaches it,
// and what each outcome looks like to the page.

const h = vi.hoisted(() => ({ submitForm: vi.fn(), after: vi.fn() }))
vi.mock('@/lib/whatsapp/forms/submit', () => ({ submitForm: h.submitForm }))
vi.mock('next/server', async (original) => ({
  ...(await original<typeof import('next/server')>()),
  after: h.after,
}))

import { POST } from './route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const TOKEN = 'a'.repeat(43)
const post = (
  body: BodyInit | null,
  { token = TOKEN, headers = {} as Record<string, string> } = {},
) =>
  POST(
    new Request(`https://app.example/api/forms/${token}`, {
      method: 'POST',
      body,
      headers,
      // Node needs this for a streamed body.
      ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
    } as RequestInit),
    { params: Promise.resolve({ token }) },
  )
const json = (value: unknown) => JSON.stringify(value)

beforeEach(() => {
  __resetRateLimitForTests()
  h.submitForm.mockReset()
  h.submitForm.mockResolvedValue({ status: 'already' })
})

describe('POST /api/forms/[token] — outcomes', () => {
  it('a stored form: 200, and the thank-you and handoff run after the response', async () => {
    const followUp = vi.fn()
    h.submitForm.mockResolvedValue({ status: 'accepted', followUp })
    const res = await post(json({ name: 'Noura' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
    expect(h.submitForm).toHaveBeenCalledWith(TOKEN, { name: 'Noura' })
    expect(h.after).toHaveBeenCalledWith(followUp)
    expect(followUp).not.toHaveBeenCalled() // left to `after`
  })

  it('a link that was already sent: the same 200, nothing more to do', async () => {
    const res = await post(json({}))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'received' })
    expect(h.after).not.toHaveBeenCalled()
  })

  it('an unknown or expired link: 410', async () => {
    h.submitForm.mockResolvedValue({ status: 'gone' })
    const res = await post(json({}))
    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({ error: 'gone' })
  })

  it('answers that were turned down: 422 with the fields', async () => {
    h.submitForm.mockResolvedValue({ status: 'invalid', fields: { name: 'required', move_date: 'past' } })
    const res = await post(json({}))
    expect(res.status).toBe(422)
    expect(await res.json()).toEqual({ error: 'invalid', fields: { name: 'required', move_date: 'past' } })
  })

  it('a failure on our side: 500, and nothing about it is told to the page', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.submitForm.mockRejectedValue(new Error('form message insert failed: relation "messages"…'))
    const res = await post(json({}))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'server_error' })
    expect(h.after).not.toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('POST /api/forms/[token] — what never reaches the form', () => {
  it.each([
    ['too short', 'abc'],
    ['bad characters', 'a'.repeat(42) + '!'],
    ['far too long', 'a'.repeat(5000)],
  ])('a malformed token (%s): 410', async (_name, token) => {
    const res = await post(json({}), { token })
    expect(res.status).toBe(410)
    expect(h.submitForm).not.toHaveBeenCalled()
  })

  it('a body that says it is over 16 KB: 413 without reading it', async () => {
    const res = await post(json({}), { headers: { 'content-length': String(16 * 1024 + 1) } })
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'too_large' })
    expect(h.submitForm).not.toHaveBeenCalled()
  })

  it('a body that is over 16 KB whatever it says: 413, and the rest is not read', async () => {
    let sent = 0
    const chunk = new TextEncoder().encode('x'.repeat(4096))
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 1
        if (sent > 1000) controller.close()
        else controller.enqueue(chunk)
      },
    })
    const res = await post(stream)
    expect(res.status).toBe(413)
    expect(h.submitForm).not.toHaveBeenCalled()
    expect(sent).toBeLessThan(20) // stopped at the cap, not after 4 MB
  })

  it('a body just under the cap is read', async () => {
    const res = await post(json({ notes: 'x'.repeat(16 * 1024 - 20) }))
    expect(res.status).toBe(200)
    expect(h.submitForm).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['not JSON', '{name: Noura'],
    ['empty', ''],
  ])('a body that is %s: 400', async (_name, body) => {
    const res = await post(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bad_json' })
    expect(h.submitForm).not.toHaveBeenCalled()
  })
})

describe('POST /api/forms/[token] — rate limits', () => {
  it('one link takes ten posts in ten minutes, then 429', async () => {
    const token = 'b'.repeat(43)
    for (let i = 0; i < 10; i++) {
      // A different address each time: this is the link's own budget.
      const res = await post(json({}), { token, headers: { 'x-forwarded-for': `10.0.0.${i}` } })
      expect(res.status).toBe(200)
    }
    const blocked = await post(json({}), { token, headers: { 'x-forwarded-for': '10.0.0.99' } })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('Retry-After')).toEqual(expect.any(String))
    expect(h.submitForm).toHaveBeenCalledTimes(10)
    // Another customer's link is not affected.
    expect((await post(json({}), { token: 'c'.repeat(43), headers: { 'x-forwarded-for': '10.0.0.99' } })).status).toBe(200)
  })

  it('one address takes sixty posts in ten minutes across links, then 429', async () => {
    const headers = { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }
    const tokenFor = (i: number) => String(i).padStart(43, 'd')
    for (let i = 0; i < 60; i++) {
      expect((await post(json({}), { token: tokenFor(i), headers })).status).toBe(200)
    }
    expect((await post(json({}), { token: tokenFor(60), headers })).status).toBe(429)
    // Someone at another address still gets through.
    expect((await post(json({}), { token: tokenFor(61), headers: { 'x-forwarded-for': '203.0.113.8' } })).status).toBe(200)
  })
})
