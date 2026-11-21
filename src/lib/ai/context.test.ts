import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildConversationContext } from './context'
import { menuMessage } from '@/lib/whatsapp/menus'

/** Minimal fake matching the query chain in buildConversationContext:
 *  from().select().eq().in().not().order().limit() → { data, error }.
 *  Rows default to content_type 'text'. */
const inFilters: [string, unknown[]][] = []
const notFilters: unknown[][] = []

function fakeDb(rows: unknown[]): SupabaseClient {
  inFilters.length = 0
  notFilters.length = 0
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    in: (col: string, vals: unknown[]) => {
      inFilters.push([col, vals])
      return chain
    },
    not: (...args: unknown[]) => {
      notFilters.push(args)
      return chain
    },
    order: () => chain,
    limit: () =>
      Promise.resolve({
        data: (rows as Record<string, unknown>[]).map((r) => ({ content_type: 'text', ...r })),
        error: null,
      }),
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
      // Outbound audio: any text on it never reached the customer.
      { sender_type: 'agent', content_type: 'audio', content_text: 'caption Meta drops' },
      { sender_type: 'bot', content_text: 'السعر ٣٠٠ ريال' },
      // A transcribed customer voice note.
      { sender_type: 'customer', content_type: 'audio', content_text: 'كم سعر التأشيرة؟' },
    ]
    const out = await buildConversationContext(fakeDb(rows), 'conv-1')
    expect(inFilters).toEqual([['content_type', ['text', 'audio', 'interactive']]])
    // Untranscribed voice notes are excluded in the query, so they can't
    // crowd real messages out of the window.
    expect(notFilters).toEqual([['content_text', 'is', null]])
    expect(out).toEqual([
      { role: 'user', content: 'كم سعر التأشيرة؟' },
      { role: 'assistant', content: 'السعر ٣٠٠ ريال' },
    ])
  })

  it("shows the bot its own form message, marked, and no other interactive message", async () => {
    const rows = [
      // newest first
      { sender_type: 'customer', content_text: 'ok' },
      // A Flow's menu and a customer's button tap: as before, not modelled.
      { sender_type: 'customer', content_type: 'interactive', content_text: 'Existing customer' },
      { sender_type: 'bot', content_type: 'interactive', content_text: 'Pick one', ai_generated: false },
      // The auto-reply bot's line that went out with the form's button.
      { sender_type: 'bot', content_type: 'interactive', content_text: 'Tap below.', ai_generated: true },
      { sender_type: 'customer', content_text: 'I need furniture moving' },
    ]
    expect(await buildConversationContext(fakeDb(rows), 'conv-1')).toEqual([
      { role: 'user', content: 'I need furniture moving' },
      { role: 'assistant', content: 'Tap below. [form sent]' },
      { role: 'user', content: 'ok' },
    ])
  })

  it("shows the bot its own menu, marked with its name, and the option the customer tapped", async () => {
    // The list as it is stored with the bot's message, and its last row.
    const services = menuMessage('services', 'ar')
    const moving = services.sections[0].rows.at(-1)!
    const rows = [
      // newest first
      // The form's button is stored as a one-button message.
      {
        sender_type: 'bot',
        content_type: 'interactive',
        content_text: 'اضغط الزر وعبّئ النموذج.',
        ai_generated: true,
        interactive_payload: { kind: 'buttons' },
      },
      // The customer's tap on the bot's menu: their answer, as text.
      {
        sender_type: 'customer',
        content_type: 'interactive',
        content_text: moving.title,
        interactive_reply_id: moving.id,
      },
      // The bot's greeting that went out with the services menu.
      {
        sender_type: 'bot',
        content_type: 'interactive',
        content_text: 'أهلاً بك، كيف نخدمك؟',
        ai_generated: true,
        interactive_payload: { kind: 'list', body: 'أهلاً بك، كيف نخدمك؟', button_label: services.buttonLabel, sections: services.sections },
      },
      { sender_type: 'customer', content_text: 'السلام عليكم' },
    ]
    expect(moving.id).toBe('menu:services:furniture_moving')
    expect(await buildConversationContext(fakeDb(rows), 'conv-1')).toEqual([
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'أهلاً بك، كيف نخدمك؟ [menu sent: services]' },
      { role: 'user', content: moving.title },
      { role: 'assistant', content: 'اضغط الزر وعبّئ النموذج. [form sent]' },
    ])
  })

  it('names the menu from the rows it was sent with, whichever menu that is', async () => {
    const list = (id: string) => ({
      sender_type: 'bot',
      content_type: 'interactive',
      content_text: 'Pick one',
      ai_generated: true,
      interactive_payload: { kind: 'list', sections: [{ rows: [{ id, title: 'A' }] }] },
    })
    const out = await buildConversationContext(
      // newest first
      fakeDb([
        // A list of the bot's with rows that are no menu's, or none at
        // all: still marked as something it sent, the way a form is.
        { ...list('plan_basic'), content_text: 'Third' },
        { ...list('menu:offers:ramadan'), content_text: 'Second' },
        { ...list('menu:services:villas'), content_text: 'First', interactive_payload: { kind: 'list' } },
      ]),
      'conv-1',
    )
    expect(out.map((m) => m.content)).toEqual([
      'First [form sent]',
      'Second [menu sent: offers]',
      'Third [form sent]',
    ])
  })

  it("leaves out taps and lists that are not the bot's own", async () => {
    const rows = [
      { sender_type: 'customer', content_text: 'thanks' },
      // A survey tap, and a tap whose id only looks a little like a menu's.
      { sender_type: 'customer', content_type: 'interactive', content_text: 'Excellent', interactive_reply_id: 'csat_5' },
      { sender_type: 'customer', content_type: 'interactive', content_text: 'Menu', interactive_reply_id: 'main_menu:open' },
      { sender_type: 'customer', content_type: 'interactive', content_text: 'No id', interactive_reply_id: null },
      // A Flow's list and a teammate's list: sent, but not by the auto-reply bot.
      {
        sender_type: 'bot',
        content_type: 'interactive',
        content_text: 'Pick a plan',
        ai_generated: false,
        interactive_payload: { kind: 'list', sections: menuMessage('services', 'en').sections },
      },
      {
        sender_type: 'agent',
        content_type: 'interactive',
        content_text: 'Choose a slot',
        ai_generated: true,
        interactive_payload: { kind: 'list', sections: menuMessage('services', 'en').sections },
      },
    ]
    expect(await buildConversationContext(fakeDb(rows), 'conv-1')).toEqual([{ role: 'user', content: 'thanks' }])
  })

  it('asks the database for what tells a menu and its tap apart', async () => {
    let columns = ''
    const db = fakeDb([]) as unknown as { select: (c: string) => unknown }
    const select = db.select
    db.select = (c: string) => ((columns = c), select(c))
    await buildConversationContext(db as unknown as SupabaseClient, 'conv-1')
    expect(columns.split(',').map((c) => c.trim())).toEqual(
      expect.arrayContaining(['ai_generated', 'interactive_reply_id', 'interactive_payload']),
    )
  })
})
