import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().order().limit() → { data, error }. */
const inFilters: [string, unknown[]][] = []

function fakeDb(rows: unknown[]): SupabaseClient {
  inFilters.length = 0
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: (col: string, vals: unknown[]) => {
      inFilters.push([col, vals])
      return chain
    },
    order: () => chain,
    limit: () => Promise.resolve({ data: rows, error: null }),
  }
  return chain as unknown as SupabaseClient
}

describe('buildConversationContext', () => {
  it('maps sender_type to role and returns chronological order', async () => {
    // DB returns newest-first (created_at DESC); the fn reverses it.
    const rows = [
      { sender_type: 'customer', content_text: 'third' },
      { sender_type: 'agent', content_text: 'second' },
      { sender_type: 'customer', content_text: 'first' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(out).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' },
      { role: 'user', content: 'third' },
    ])
  })

  it('treats bot messages as assistant', async () => {
    const out = await buildConversationContext(
      fakeDb([{ sender_type: 'bot', content_text: 'auto reply' }]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'assistant', content: 'auto reply' }])
  })

  it('drops empty / whitespace-only messages', async () => {
    const out = await buildConversationContext(
      fakeDb([
        { sender_type: 'customer', content_text: '   ' },
        { sender_type: 'customer', content_text: null },
        { sender_type: 'customer', content_text: 'real' },
      ]),
      'conv-1',
    )
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('reads voice notes too, and treats a transcribed one as customer text', async () => {
    // Audio rows carry their transcript in content_text (newest first).
    const rows = [
      { sender_type: 'bot', content_text: null }, // the bot's own spoken reply
      { sender_type: 'bot', content_text: 'السعر ٣٠٠ ريال' },
      { sender_type: 'customer', content_text: 'كم سعر التأشيرة؟' }, // transcribed voice note
      { sender_type: 'customer', content_text: null }, // voice note never transcribed
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(inFilters).toEqual([['content_type', ['text', 'audio']]])
    expect(out).toEqual([
      { role: 'user', content: 'كم سعر التأشيرة؟' },
      { role: 'assistant', content: 'السعر ٣٠٠ ريال' },
    ])
  })
})
