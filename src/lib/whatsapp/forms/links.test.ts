import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createFormLink, findFormLink, hashToken, isToken, LINK_TTL_MS } from './links'

type Row = Record<string, unknown>

/** Only what links.ts asks of Supabase: insert a row, find one by hash. */
function fakeDb(opts: { insertError?: string; selectError?: string } = {}) {
  const rows: Row[] = []
  let lookups = 0
  const db = {
    from: (table: string) => {
      if (table !== 'form_links') throw new Error(`unexpected table ${table}`)
      return {
        insert: async (row: Row) => {
          if (opts.insertError) return { error: { message: opts.insertError } }
          rows.push({ id: `link-${rows.length + 1}`, submitted_at: null, answers: null, ...row })
          return { error: null }
        },
        select: () => ({
          eq: (column: string, value: unknown) => ({
            maybeSingle: async () => {
              lookups += 1
              if (opts.selectError) return { data: null, error: { message: opts.selectError } }
              return { data: rows.find((r) => r[column] === value) ?? null, error: null }
            },
          }),
        }),
      }
    },
  }
  return { db: db as unknown as SupabaseClient, rows, lookups: () => lookups }
}

const LINK = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  form: 'furniture_moving',
  lang: 'ar' as const,
}
const tokenOf = (url: string) => url.split('/form/')[1]

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://app.example/'))
afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('createFormLink', () => {
  it('returns the form address with nothing in it but a random token', async () => {
    const { db } = fakeDb()
    const url = await createFormLink(db, LINK)
    expect(url).toMatch(/^https:\/\/app\.example\/form\/[A-Za-z0-9_-]{43}$/) // no double slash
    for (const secret of ['acct-1', 'conv-1', 'contact-1', 'furniture', '966']) {
      expect(url).not.toContain(secret)
    }
    expect(tokenOf(await createFormLink(db, LINK))).not.toBe(tokenOf(url))
  })

  it('stores which chat, form and language the token stands for, but only the hash of the token', async () => {
    const { db, rows } = fakeDb()
    const before = Date.now()
    const token = tokenOf(await createFormLink(db, LINK))
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      token_hash: crypto.createHash('sha256').update(token).digest('hex'),
      account_id: 'acct-1',
      conversation_id: 'conv-1',
      contact_id: 'contact-1',
      form: 'furniture_moving',
      lang: 'ar',
    })
    expect(JSON.stringify(rows[0])).not.toContain(token)
    const expires = Date.parse(rows[0].expires_at as string)
    expect(expires).toBeGreaterThanOrEqual(before + LINK_TTL_MS)
    expect(expires).toBeLessThanOrEqual(Date.now() + LINK_TTL_MS)
    expect(LINK_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })

  it.each([undefined, '', '   '])('says so when the site address is not set (%j)', async (value) => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', value as unknown as string)
    const { db, rows } = fakeDb()
    await expect(createFormLink(db, LINK)).rejects.toThrow(/NEXT_PUBLIC_SITE_URL is not set/)
    expect(rows).toEqual([]) // no link nobody can open
  })

  it('throws when the link cannot be saved, so no dead button goes out', async () => {
    const { db } = fakeDb({ insertError: 'relation "form_links" does not exist' })
    await expect(createFormLink(db, LINK)).rejects.toThrow(
      'the form link could not be saved: relation "form_links" does not exist',
    )
  })
})

describe('findFormLink', () => {
  it('opens a fresh link', async () => {
    const { db, rows } = fakeDb()
    const token = tokenOf(await createFormLink(db, LINK))
    expect(await findFormLink(db, token)).toEqual({ status: 'open', link: rows[0] })
  })

  it('stops working after seven days', async () => {
    vi.useFakeTimers()
    const { db } = fakeDb()
    const token = tokenOf(await createFormLink(db, LINK))
    vi.advanceTimersByTime(LINK_TTL_MS - 1000)
    expect((await findFormLink(db, token)).status).toBe('open')
    vi.advanceTimersByTime(1000)
    expect(await findFormLink(db, token)).toEqual({ status: 'invalid' })
  })

  it('reports a used link as submitted, with what was sent — even past its expiry', async () => {
    vi.useFakeTimers()
    const { db, rows } = fakeDb()
    const token = tokenOf(await createFormLink(db, LINK))
    Object.assign(rows[0], { submitted_at: new Date().toISOString(), answers: { name: 'Noura' } })
    vi.advanceTimersByTime(LINK_TTL_MS * 2)
    const state = await findFormLink(db, token)
    expect(state).toEqual({ status: 'submitted', link: rows[0] })
    expect(state.status === 'submitted' && state.link.answers).toEqual({ name: 'Noura' })
  })

  it('rejects a token with one character changed', async () => {
    const { db } = fakeDb()
    const token = tokenOf(await createFormLink(db, LINK))
    const tampered = (token[0] === 'A' ? 'B' : 'A') + token.slice(1)
    expect(isToken(tampered)).toBe(true) // well-formed, just not ours
    expect(await findFormLink(db, tampered)).toEqual({ status: 'invalid' })
  })

  it.each([
    ['empty', ''],
    ['too short', 'a'.repeat(42)],
    ['too long', 'a'.repeat(44)],
    ['a path', '../../etc/passwd'],
    ['bad characters', 'a'.repeat(42) + '!'],
    ['a huge string', 'a'.repeat(100_000)],
  ])('turns away a malformed token (%s) without asking the database', async (_name, token) => {
    const { db, lookups } = fakeDb()
    expect(await findFormLink(db, token)).toEqual({ status: 'invalid' })
    expect(lookups()).toBe(0)
  })

  it('throws when the database fails, rather than calling a good link invalid', async () => {
    const { db } = fakeDb({ selectError: 'connection reset' })
    await expect(findFormLink(db, 'a'.repeat(43))).rejects.toThrow('form link lookup failed: connection reset')
  })
})

describe('hashToken', () => {
  it('is SHA-256, hex', () => {
    expect(hashToken('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})
