import crypto from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>

// An in-memory stand-in for the four tables the submit path touches.
// Filters are applied for real, and an UPDATE finds and changes its rows
// in one step — so the claim (`submitted_at IS NULL AND expires_at > now`)
// can only be won once, as in Postgres.
const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  tables: {} as Record<string, Record<string, unknown>[]>,
  /** `"<table>.<insert|select|update>"` → the error that call returns. */
  errors: {} as Record<string, string>,
  /** Runs after a row is read — lets a test move the clock mid-request. */
  afterRead: null as (() => void) | null,
}))

vi.mock('@/lib/ai/auto-reply', () => ({ dispatchFormSubmissionToAiReply: h.dispatch }))
vi.mock('@/lib/ai/admin-client', () => ({
  supabaseAdmin: () => ({
    // `submit_form_link` (migration 041): use the link up and store the
    // message, together or not at all.
    rpc: async (fn: string, args: { p_id: string; p_answers: Row; p_text: string }) => {
      const error = h.errors[`rpc.${fn}`]
      if (error) return { data: null, error: { message: error } }
      const now = new Date().toISOString()
      const row = (h.tables.form_links ?? []).find(
        (r) => r.id === args.p_id && (r.submitted_at ?? null) === null && (r.expires_at as string) > now,
      )
      if (!row) return { data: false, error: null }
      Object.assign(row, { submitted_at: now, answers: args.p_answers })
      h.tables.messages.push({
        conversation_id: row.conversation_id,
        sender_type: 'customer',
        content_type: 'text',
        content_text: args.p_text,
        message_id: `form:${args.p_id}`,
        status: 'delivered',
      })
      return { data: true, error: null }
    },
    from: (name: string) => {
      const rows = (h.tables[name] ??= [])
      const query = (op: 'select' | 'update', patch?: Row) => {
        const filters: ((r: Row) => boolean)[] = []
        const run = () => {
          const error = h.errors[`${name}.${op}`]
          if (error) return { data: null, error: { message: error } }
          const hit = rows.filter((r) => filters.every((f) => f(r)))
          if (op === 'update') hit.forEach((r) => Object.assign(r, patch))
          return { data: hit.map((r) => ({ ...r })), error: null }
        }
        const q = {
          eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), q),
          is: (c: string, v: unknown) => (filters.push((r) => (r[c] ?? null) === v), q),
          gt: (c: string, v: string) => (filters.push((r) => (r[c] as string) > v), q),
          select: async () => run(), // `update(...).select('id')`
          maybeSingle: async () => {
            const { data, error } = run()
            h.afterRead?.()
            return { data: data?.[0] ?? null, error }
          },
          then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) =>
            Promise.resolve(run()).then(ok, bad),
        }
        return q
      }
      return {
        insert: async (row: Row) => {
          const error = h.errors[`${name}.insert`]
          if (error) return { error: { message: error } }
          rows.push({ ...row })
          return { error: null }
        },
        select: () => query('select'),
        update: (patch: Row) => query('update', patch),
      }
    },
  }),
}))

import { submitForm } from './submit'
import { hashToken } from './links'

const DAY = 86_400_000
const newToken = () => crypto.randomBytes(32).toString('base64url')
const link = (token: string, overrides: Row = {}): Row => ({
  id: 'link-1',
  token_hash: hashToken(token),
  account_id: 'acct-1',
  conversation_id: 'conv-1',
  contact_id: 'contact-1',
  form: 'furniture_moving',
  lang: 'en',
  expires_at: new Date(Date.now() + 7 * DAY).toISOString(),
  submitted_at: null,
  answers: null,
  ...overrides,
})

/** What the page posts for a complete form. */
const ANSWERS = {
  lang: 'en',
  move_type: 'within',
  city: 'riyadh',
  from_district: 'Al Malqa',
  from_floor: '2',
  to_district: 'Al Yasmin',
  to_floor: 'ground',
  move_date: new Date(Date.now() + 7 * DAY).toISOString().slice(0, 10),
  qty_wardrobes: 3,
  cabinets: 'no',
  pack_kitchen: 'yes',
  name: 'Noura',
}

let token: string
const theLink = () => h.tables.form_links[0]
const messages = () => h.tables.messages

beforeEach(() => {
  token = newToken()
  h.tables = {
    form_links: [link(token)],
    messages: [],
    conversations: [{ id: 'conv-1', unread_count: 2, last_message_text: 'hi' }],
    whatsapp_config: [{ account_id: 'acct-1', user_id: 'user-1' }],
  }
  h.errors = {}
  h.afterRead = null
  h.dispatch.mockReset()
  h.dispatch.mockResolvedValue(undefined)
})

describe('submitForm — a complete form', () => {
  it('stores the answers as one customer message in the chat', async () => {
    const result = await submitForm(token, ANSWERS)
    expect(result.status).toBe('accepted')
    expect(messages()).toEqual([
      {
        conversation_id: 'conv-1',
        sender_type: 'customer',
        content_type: 'text',
        content_text: expect.stringMatching(/^📋 Furniture moving form\nName: Noura\n/),
        message_id: 'form:link-1',
        status: 'delivered',
      },
    ])
    expect(messages()[0].content_text).toContain('Furniture: Wardrobes ×3')
  })

  it('uses the link up and keeps only the checked answers', async () => {
    await submitForm(token, { ...ANSWERS, evil: '<script>', account_id: 'acct-2' })
    expect(theLink().submitted_at).toEqual(expect.any(String))
    expect(theLink().answers).toMatchObject({ form: 'furniture_moving', lang: 'en', name: 'Noura', qty_wardrobes: 3, qty_sofas: 0 })
    expect(theLink().answers).not.toHaveProperty('evil')
    expect(theLink().answers).not.toHaveProperty('account_id')
  })

  it('puts the form at the top of the chat list as one more unread message', async () => {
    await submitForm(token, ANSWERS)
    expect(h.tables.conversations[0]).toMatchObject({
      last_message_text: '📋 Furniture moving form', // the title, not fourteen lines
      unread_count: 3,
      last_message_at: theLink().submitted_at,
    })
  })

  it('still counts as sent when only the chat-list preview could not be updated', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.errors['conversations.update'] = 'timeout'
    expect((await submitForm(token, ANSWERS)).status).toBe('accepted')
    expect(messages()).toHaveLength(1)
    logged.mockRestore()
  })

  it('then thanks the customer and hands the chat over, once', async () => {
    const result = await submitForm(token, ANSWERS)
    expect(h.dispatch).not.toHaveBeenCalled() // only after the customer has their answer
    if (result.status !== 'accepted') throw new Error('not accepted')
    await result.followUp()
    expect(h.dispatch.mock.calls).toEqual([
      [
        {
          accountId: 'acct-1',
          conversationId: 'conv-1',
          contactId: 'contact-1',
          configOwnerUserId: 'user-1',
          submission: expect.objectContaining({
            form: 'furniture_moving',
            text: messages()[0].content_text,
            thankYou: expect.stringContaining('Thank you, Noura.'),
            lead: expect.objectContaining({ service: 'furniture_moving', quoted_price_sar: null, customer_name: 'Noura' }),
          }),
        },
      ],
    ])
  })

  it.each([
    ['the handoff fails', () => h.dispatch.mockRejectedValue(new Error('db down'))],
    ['the account has no WhatsApp number any more', () => (h.tables.whatsapp_config = [])],
  ])('the follow-up never throws when %s', async (_name, arrange) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await submitForm(token, ANSWERS)
    arrange()
    if (result.status !== 'accepted') throw new Error('not accepted')
    await expect(result.followUp()).resolves.toBeUndefined()
    expect(messages()).toHaveLength(1) // the answers are in the chat either way
    logged.mockRestore()
  })
})

describe('submitForm — one link, one submission', () => {
  it('a second Send changes nothing', async () => {
    const first = await submitForm(token, ANSWERS)
    if (first.status === 'accepted') await first.followUp()
    const second = await submitForm(token, { ...ANSWERS, name: 'Someone else' })
    expect(second).toEqual({ status: 'already' }) // nothing to follow up
    expect(messages()).toHaveLength(1)
    expect(theLink().answers).toMatchObject({ name: 'Noura' })
    expect(h.tables.conversations[0].unread_count).toBe(3)
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a double tap makes one message and one handoff', async () => {
    const results = await Promise.all([submitForm(token, ANSWERS), submitForm(token, ANSWERS)])
    expect(results.map((r) => r.status).sort()).toEqual(['accepted', 'already'])
    expect(messages()).toHaveLength(1)
    expect(h.tables.conversations[0].unread_count).toBe(3)
    await Promise.all(results.map((r) => (r.status === 'accepted' ? r.followUp() : null)))
    expect(h.dispatch).toHaveBeenCalledTimes(1)
  })

  it('a link that runs out between the check and the claim is gone, not sent', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      theLink().expires_at = new Date(Date.now() + 1000).toISOString()
      // Open when looked up; two seconds pass before the claim.
      h.afterRead = () => {
        h.afterRead = null
        vi.setSystemTime(Date.now() + 2000)
      }
      expect(await submitForm(token, ANSWERS)).toEqual({ status: 'gone' })
      expect(messages()).toEqual([])
      expect(theLink().submitted_at).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('submitForm — what is turned away', () => {
  const untouched = () => {
    expect(messages()).toEqual([])
    expect(h.tables.conversations[0]).toMatchObject({ unread_count: 2, last_message_text: 'hi' })
    expect(h.dispatch).not.toHaveBeenCalled()
  }

  it('answers that fail the form’s own check: nothing stored, link still open', async () => {
    const result = await submitForm(token, { ...ANSWERS, name: '', city: 'atlantis', qty_wardrobes: 9999 })
    expect(result).toEqual({
      status: 'invalid',
      fields: { name: 'required', city: 'invalid', qty_wardrobes: 'invalid' },
    })
    untouched()
    expect(theLink()).toMatchObject({ submitted_at: null, answers: null })
    expect((await submitForm(token, ANSWERS)).status).toBe('accepted') // fixed and sent again
  })

  it.each([
    ['is not an object', 'hello'],
    ['is null', null],
    ['is a list', [ANSWERS]],
  ])('a body that %s', async (_name, body) => {
    expect((await submitForm(token, body)).status).toBe('invalid')
    untouched()
  })

  it('a token nobody was sent', async () => {
    expect(await submitForm(newToken(), ANSWERS)).toEqual({ status: 'gone' })
    untouched()
  })

  it('a token with one character changed', async () => {
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1)
    expect(await submitForm(tampered, ANSWERS)).toEqual({ status: 'gone' })
    untouched()
    expect(theLink().submitted_at).toBeNull()
  })

  it('an expired link', async () => {
    theLink().expires_at = new Date(Date.now() - 1000).toISOString()
    expect(await submitForm(token, ANSWERS)).toEqual({ status: 'gone' })
    untouched()
    expect(theLink().submitted_at).toBeNull()
  })

  it.each(['free_money', 'constructor', '__proto__'])('a link for a form this build does not have (%s)', async (form) => {
    theLink().form = form
    expect(await submitForm(token, ANSWERS)).toEqual({ status: 'gone' })
    untouched()
  })
})

describe('submitForm — when the database fails', () => {
  it('stores nothing when the database turns the submission down, so the customer can send again', async () => {
    h.errors['rpc.submit_form_link'] = 'insert timeout'
    await expect(submitForm(token, ANSWERS)).rejects.toThrow('form submit failed: insert timeout')
    expect(messages()).toEqual([])
    expect(theLink()).toMatchObject({ submitted_at: null, answers: null }) // not "sent" with nothing in the chat
    expect(h.tables.conversations[0].unread_count).toBe(2)

    delete h.errors['rpc.submit_form_link']
    expect((await submitForm(token, ANSWERS)).status).toBe('accepted')
    expect(messages()).toHaveLength(1)
  })

  it('throws when the link cannot be looked up', async () => {
    h.errors['form_links.select'] = 'connection reset'
    await expect(submitForm(token, ANSWERS)).rejects.toThrow('form link lookup failed: connection reset')
    expect(messages()).toEqual([])
  })
})
