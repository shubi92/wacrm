import { describe, expect, it } from 'vitest'
import { isMenuReplyId, menuMessage } from '@/lib/whatsapp/menus'

// A tap on a list message comes back as `interactive.list_reply`. For a
// menu the AI agent sent, the row's title is the customer's answer: it
// is what the inbox shows, what the agent reads, and what goes out as
// `message.received`; the id says which menu and row it was.

const { parseMessageContent } = await import('./parse-message')

const base = { id: 'wamid.TEST', from: '966500000000', timestamp: '1700000000', type: 'interactive' }
const tap = (id: string, title: string) => ({
  ...base,
  interactive: { type: 'list_reply' as const, list_reply: { id, title } },
})

describe('parseMessageContent — a tap on a list', () => {
  it("reads a tap on the bot's services menu as the service the customer chose", async () => {
    const row = menuMessage('services', 'ar').sections[0].rows.at(-1)!
    const result = await parseMessageContent(tap(row.id, row.title), 'token')
    expect(row.id).toBe('menu:services:furniture_moving')
    expect(result).toMatchObject({
      contentText: row.title, // "نقل عفش": what the agent's moving rule answers
      interactiveReplyId: 'menu:services:furniture_moving',
      mediaUrl: null,
    })
    // This id is what lets the tap through to the agent (see route.ts).
    expect(isMenuReplyId(result.interactiveReplyId)).toBe(true)
  })

  it("reads a tap on any other list the same way, without it being the bot's", async () => {
    const result = await parseMessageContent(tap('plan_basic', 'Basic plan'), 'token')
    expect(result).toMatchObject({ contentText: 'Basic plan', interactiveReplyId: 'plan_basic' })
    expect(isMenuReplyId(result.interactiveReplyId)).toBe(false)
  })
})
