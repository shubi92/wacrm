import { beforeEach, describe, expect, it, vi } from 'vitest'

// `sent_by_person` marks a message a person wrote (a rep replying from a
// connected app). It must reach the send core as a sender, so the AI bot
// counts it as the team taking over; anything else must send as before.
const h = vi.hoisted(() => ({
  send: vi.fn(),
  createdBy: 'owner-1' as string | null,
}))

vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: async () => ({
    authType: 'api_key',
    supabase: {},
    accountId: 'acct-1',
    keyId: 'key-1',
    scopes: ['messages:send'],
    createdBy: h.createdBy,
  }),
}))
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: async () => ({
    conversationId: 'conv-1',
    contactId: 'contact-1',
    contactCreated: false,
  }),
}))
vi.mock('@/lib/whatsapp/send-message', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/send-message')>()),
  sendMessageToConversation: h.send,
}))

import { POST } from './route'

const post = (body: Record<string, unknown>) =>
  POST(
    new Request('https://x/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ to: '+966500000000', text: 'hi', ...body }),
    }),
  )
const senderSent = () => h.send.mock.calls[0][2].senderId

beforeEach(() => {
  h.send.mockReset()
  h.send.mockResolvedValue({ messageId: 'm1', whatsappMessageId: 'wamid.1' })
  h.createdBy = 'owner-1'
})

describe('POST /api/v1/messages — sent_by_person', () => {
  it('true: stored with a sender (the key’s creator), like an inbox reply', async () => {
    const res = await post({ sent_by_person: true })
    expect(res.status).toBe(201)
    expect(senderSent()).toBe('owner-1')
  })

  it('true, with the key’s creator gone: the key itself is the sender', async () => {
    h.createdBy = null
    await post({ sent_by_person: true })
    expect(senderSent()).toBe('key-1')
  })

  it.each([['left out', {}], ['false', { sent_by_person: false }]])(
    '%s: no sender, as every automatic send today',
    async (_name, extra) => {
      const res = await post(extra)
      expect(res.status).toBe(201)
      expect(senderSent()).toBeNull()
    },
  )

  it('anything but true/false is refused before sending', async () => {
    const res = await post({ sent_by_person: 'true' })
    expect(res.status).toBe(400)
    expect(h.send).not.toHaveBeenCalled()
  })
})
