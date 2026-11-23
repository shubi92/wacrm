import { describe, it, expect } from 'vitest'
import {
  buildHandoffSummary,
  handoffFallbackMessage,
  isBotHandoffSummary,
  isReplyCapSummary,
  isWaitingMessage,
  replyCapSummary,
  waitingMessage,
} from './handoff'
import type { HandoffLead } from './lead'

describe('buildHandoffSummary', () => {
  it('notes the reply count and quotes the last customer message', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'I want a refund' },
      ],
      replyCount: 2,
    })
    expect(summary).toBe(
      '🤖 AI agent handed off after 2 replies. The bot chose to hand off. Last customer message: “I want a refund”',
    )
  })

  it('uses the singular "reply" for a count of one', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'help' }],
      replyCount: 1,
    })
    expect(summary).toContain('after 1 reply.')
  })

  it('says "without replying" when the bot bailed on the first inbound', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: 'agent please' }],
      replyCount: 0,
    })
    expect(summary).toContain('handed off without replying.')
    expect(summary).toContain('“agent please”')
  })

  it('picks the most recent customer turn, ignoring assistant turns', () => {
    const summary = buildHandoffSummary({
      messages: [
        { role: 'user', content: 'first' },
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'a reply' },
      ],
      replyCount: 1,
    })
    expect(summary).toContain('“second”')
  })

  it('collapses whitespace and truncates a long message', () => {
    const long = 'x'.repeat(300)
    const summary = buildHandoffSummary({
      messages: [{ role: 'user', content: long }],
      replyCount: 0,
    })
    expect(summary).toContain('…')
    // 160-char cap on the quote; the whole note stays well under 300.
    expect(summary.length).toBeLessThan(300)
  })

  it('degrades gracefully when there is no customer message', () => {
    const summary = buildHandoffSummary({
      messages: [{ role: 'assistant', content: 'greeting' }],
      replyCount: 0,
    })
    expect(summary).toBe('🤖 AI agent handed off without replying. The bot chose to hand off.')
  })
})

describe('buildHandoffSummary — ready customer', () => {
  const messages = [{ role: 'user' as const, content: 'نعم، احجزوا لي' }]
  const lead: HandoffLead = {
    service: 'kitchen_bathroom_cleaning',
    details: [{ question: 'كم عدد دورات المياه؟', answer: '٢' }],
    quoted_price_sar: 300,
    customer_name: 'أحمد',
    area: 'الرياض - حي النرجس',
    preferred_date: 'يوم الخميس',
  }

  it('leads the note with the service, quoted price, name, area and date', () => {
    expect(buildHandoffSummary({ messages, replyCount: 2, lead, ready: true })).toBe(
      '🤖 AI agent handed off after 2 replies. Customer is ready: kitchen bathroom cleaning, quoted 300 SAR, أحمد, الرياض - حي النرجس, يوم الخميس. Last customer message: “نعم، احجزوا لي”',
    )
  })

  it('omits null fields cleanly', () => {
    const summary = buildHandoffSummary({
      messages,
      replyCount: 1,
      ready: true,
      lead: { ...lead, quoted_price_sar: null, customer_name: null, preferred_date: null },
    })
    expect(summary).toBe(
      '🤖 AI agent handed off after 1 reply. Customer is ready: kitchen bathroom cleaning, الرياض - حي النرجس. Last customer message: “نعم، احجزوا لي”',
    )
    expect(summary).not.toContain('null')
    expect(summary).not.toContain('quoted')
    expect(summary).not.toMatch(/,\s*,/)
  })

  it('names just the service when nothing else is known', () => {
    const summary = buildHandoffSummary({
      messages: [],
      replyCount: 1,
      ready: true,
      lead: { ...lead, quoted_price_sar: null, customer_name: null, area: null, preferred_date: null },
    })
    expect(summary).toBe('🤖 AI agent handed off after 1 reply. Customer is ready: kitchen bathroom cleaning.')
  })

  it('lists what was collected without calling the customer ready when they have not said yes', () => {
    expect(buildHandoffSummary({ messages: [], replyCount: 2, lead })).toBe(
      '🤖 AI agent handed off after 2 replies. Collected so far: kitchen bathroom cleaning, quoted 300 SAR, أحمد, الرياض - حي النرجس, يوم الخميس.',
    )
  })

  it('says the details could not be read when the lead was unreadable', () => {
    const summary = buildHandoffSummary({ messages, replyCount: 1, lead: null, leadUnreadable: true })
    expect(summary).toContain('could not be read')
    expect(summary).not.toContain('Customer is ready')
    expect(summary).toContain('Last customer message: “نعم، احجزوا لي”')
  })

  it('a plain handoff says the bot chose it', () => {
    const plain = '🤖 AI agent handed off after 2 replies. The bot chose to hand off. Last customer message: “نعم، احجزوا لي”'
    expect(buildHandoffSummary({ messages, replyCount: 2 })).toBe(plain)
    expect(buildHandoffSummary({ messages, replyCount: 2, lead: null, leadUnreadable: false })).toBe(plain)
  })
})

describe('handoffFallbackMessage', () => {
  it('is Arabic for Arabic script and English otherwise', () => {
    expect(handoffFallbackMessage('كم السعر؟')).toMatch(/[\u0600-\u06FF]/)
    expect(handoffFallbackMessage('ok تمام')).toMatch(/[\u0600-\u06FF]/)
    expect(handoffFallbackMessage('What services do you provide?')).toMatch(/^Your request/)
    expect(handoffFallbackMessage('')).toMatch(/^Your request/)
  })
})

describe('buildHandoffSummary — unusable output', () => {
  const messages = [{ role: 'user' as const, content: 'وش الخدمات اللي عندكم؟' }]

  it('says the bot did not choose the handoff, and quotes what it wrote', () => {
    const note = buildHandoffSummary({
      messages,
      replyCount: 2,
      unsendable: { raw: 'عندنا تنظيف\nالمكيفات', retried: true },
    })
    expect(note).toBe(
      '🤖 AI agent handed off after 2 replies. The bot did not choose this: its answer could not be sent (no complete <reply> block), even on a second try. It wrote: “عندنا تنظيف المكيفات” Last customer message: “وش الخدمات اللي عندكم؟”',
    )
    expect(note).not.toContain('chose to hand off')
  })

  it('keeps a long answer to a short excerpt, and does not claim a second try that never ran', () => {
    const note = buildHandoffSummary({ messages, replyCount: 0, unsendable: { raw: 'x'.repeat(900), retried: false } })
    expect(note).not.toContain('second try')
    expect(note.length).toBeLessThan(450)
  })
})

describe('the reply-cap note', () => {
  it('is recognised whatever the limit was, and nothing else is', () => {
    expect(replyCapSummary(8)).toBe(
      '🤖 AI agent handed off: it reached its limit of 8 replies on this chat. Please take over.',
    )
    expect(isReplyCapSummary(replyCapSummary(8))).toBe(true)
    expect(isReplyCapSummary(replyCapSummary(20))).toBe(true)
    expect(isReplyCapSummary(buildHandoffSummary({ messages: [], replyCount: 8 }))).toBe(false)
    expect(isReplyCapSummary(null)).toBe(false)
  })
})

describe('isBotHandoffSummary', () => {
  it('recognises every note the bot writes on a handoff', () => {
    const messages = [{ role: 'user' as const, content: 'hi' }]
    for (const note of [
      buildHandoffSummary({ messages, replyCount: 0 }),
      buildHandoffSummary({ messages, replyCount: 2, leadUnreadable: true }),
      buildHandoffSummary({ messages, replyCount: 1, unsendable: { raw: 'x', retried: true } }),
      replyCapSummary(3),
    ]) {
      expect(isBotHandoffSummary(note)).toBe(true)
    }
  })

  it('not a pause a person or another system made', () => {
    expect(isBotHandoffSummary(null)).toBe(false)
    expect(isBotHandoffSummary('')).toBe(false)
    expect(isBotHandoffSummary('⏸ AI agent paused by a connected system (API).')).toBe(false)
  })
})

describe('waitingMessage', () => {
  it('follows the language of the customer’s last message', () => {
    expect(waitingMessage('وين الرد؟')).toBe(
      'وصلت رسالتك 🌿 محادثتك الآن عند فريق المبيعات، وبيرد عليك أحد الزملاء في أقرب وقت.',
    )
    expect(waitingMessage('any news?')).toBe(
      'We got your message. Your chat is now with our sales team, and one of them will reply as soon as possible.',
    )
    expect(waitingMessage('')).toBe(waitingMessage('any news?'))
  })

  it('is recognised in the chat afterwards, and the goodbye is not', () => {
    expect(isWaitingMessage(waitingMessage('مرحبا'))).toBe(true)
    expect(isWaitingMessage(waitingMessage('hello'))).toBe(true)
    expect(isWaitingMessage(handoffFallbackMessage('hello'))).toBe(false)
    expect(isWaitingMessage(null)).toBe(false)
  })
})
