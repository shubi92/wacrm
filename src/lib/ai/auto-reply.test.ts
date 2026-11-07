import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    // `messages` rows; the mock applies the query's real filters to them.
    messageRows: [] as Record<string, unknown>[],
    recentOutboundError: null as { message: string } | null,
    outboundFilters: [] as [string, string, unknown][],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    rpcCalls: [] as { name: string; args: unknown }[],
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'automations') {
        // .select().eq().eq().in().limit() → active auto-responders
        const chain = {
          select: () => chain,
          eq: () => chain,
          in: () => chain,
          limit: () =>
            Promise.resolve({ data: h.state.autoResponders, error: null }),
        }
        return chain
      }
      if (table === 'messages') {
        // .select().eq().in().eq().gte().limit() → recent non-AI outbound.
        // Filters are applied to `messageRows`, so a wrong column or value
        // in the query changes the result instead of passing silently.
        const filters: [string, string, unknown][] = []
        const record =
          (op: string) =>
          (col: string, val: unknown) => {
            filters.push([op, col, val])
            h.state.outboundFilters.push([op, col, val])
            return chain
          }
        const matches = (row: Record<string, unknown>) =>
          filters.every(([op, col, val]) => {
            if (!(col in row)) return false // unknown column never matches
            if (op === 'eq') return row[col] === val
            if (op === 'in') return (val as unknown[]).includes(row[col])
            return String(row[col]) >= String(val) // gte on ISO timestamps
          })
        const chain = {
          select: () => chain,
          eq: record('eq'),
          in: record('in'),
          gte: record('gte'),
          limit: (n: number) =>
            Promise.resolve(
              h.state.recentOutboundError
                ? { data: null, error: h.state.recentOutboundError }
                : {
                    data: h.state.messageRows.filter(matches).slice(0, n),
                    error: null,
                  },
            ),
        }
        return chain
      }
      // conversations
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: h.state.conv, error: null }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          return { eq: () => Promise.resolve({ error: null }) }
        },
      }
    },
    rpc: (name: string, args: unknown) => {
      h.state.rpcCalls.push({ name, args })
      return Promise.resolve({ data: h.state.claim, error: null })
    },
  }),
}))

import { dispatchInboundToAiReply } from './auto-reply'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

function aiConfig(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffAgentId: null,
    embeddingsApiKey: null,
    ...overrides,
  }
}

beforeEach(() => {
  h.state.conv = {
    assigned_agent_id: null,
    ai_autoreply_disabled: false,
    ai_reply_count: 0,
  }
  h.state.autoResponders = []
  h.state.messageRows = []
  h.state.recentOutboundError = null
  h.state.outboundFilters = []
  h.state.claim = true
  h.state.updatePayload = null
  h.state.rpcCalls = []
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
})

describe('dispatchInboundToAiReply — eligibility gates', () => {
  it('claims a slot and sends on the happy path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toEqual([
      {
        name: 'claim_ai_reply_slot',
        args: { conversation_id: 'conv-1', max_replies: 3 },
      },
    ])
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
  })

  it('grounds the reply in retrieved knowledge', async () => {
    h.retrieveKnowledge.mockResolvedValue(['Returns accepted within 30 days.'])
    await dispatchInboundToAiReply(ARGS)
    expect(h.retrieveKnowledge).toHaveBeenCalled()
    const systemPrompt = h.generateReply.mock.calls[0][0].systemPrompt as string
    expect(systemPrompt).toContain('Returns accepted within 30 days.')
  })

  it('stands down when an active message-level automation exists', async () => {
    h.state.autoResponders = [{ id: 'auto-1' }]
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the atomic slot claim loses the race', async () => {
    h.state.claim = false
    await dispatchInboundToAiReply(ARGS)
    // It still attempts the claim, but the send is skipped.
    expect(h.state.rpcCalls).toHaveLength(1)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when AI is off / not configured', async () => {
    h.loadAiConfig.mockResolvedValue(null)
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply is disabled for the account', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ autoReplyEnabled: false }))
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when a human agent is assigned', async () => {
    h.state.conv = {
      assigned_agent_id: 'agent-9',
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when auto-reply was disabled on this conversation', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: true,
      ai_reply_count: 0,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('skips when the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  describe('others already active on the thread', () => {
    const NOW = Date.parse('2026-11-03T12:00:00.000Z')
    const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString()
    const row = (overrides: Record<string, unknown>) => ({
      conversation_id: 'conv-1',
      sender_type: 'agent',
      ai_generated: false,
      created_at: hoursAgo(1),
      ...overrides,
    })

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(NOW)
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('queries exactly: this thread, agent/bot, non-AI, created_at within 24h', async () => {
      await dispatchInboundToAiReply(ARGS)
      const f = h.state.outboundFilters
      expect(f).toContainEqual(['eq', 'conversation_id', 'conv-1'])
      expect(f).toContainEqual(['in', 'sender_type', ['agent', 'bot']])
      expect(f).toContainEqual(['eq', 'ai_generated', false])
      expect(f).toContainEqual(['gte', 'created_at', hoursAgo(24)])
    })

    it.each([
      ['an API/CRM or inbox agent send', row({})],
      ['a Flow/Automation bot send', row({ sender_type: 'bot' })],
    ])('skips after %s in the last 24h', async (_label, msg) => {
      h.state.messageRows = [msg]
      await dispatchInboundToAiReply(ARGS)
      expect(h.generateReply).not.toHaveBeenCalled()
      expect(h.engineSendText).not.toHaveBeenCalled()
    })

    it('still replies past its own AI replies, older sends, and other threads', async () => {
      h.state.messageRows = [
        row({ sender_type: 'bot', ai_generated: true }), // its own reply
        row({ created_at: hoursAgo(25) }), // outside the window
        row({ conversation_id: 'conv-2' }), // another thread
        row({ sender_type: 'customer' }), // inbound
      ]
      await dispatchInboundToAiReply(ARGS)
      expect(h.engineSendText).toHaveBeenCalledWith(
        expect.objectContaining({ conversationId: 'conv-1', aiGenerated: true }),
      )
    })

    it('does not send when someone replies while the reply is generating', async () => {
      h.generateReply.mockImplementation(async () => {
        h.state.messageRows.push(row({ created_at: new Date(NOW).toISOString() }))
        return { text: 'Hello!', handoff: false }
      })
      await dispatchInboundToAiReply(ARGS)
      expect(h.generateReply).toHaveBeenCalled()
      expect(h.state.rpcCalls).toHaveLength(0) // no reply slot burned
      expect(h.engineSendText).not.toHaveBeenCalled()
    })

    it('replies after Resume AI despite the resumer’s own earlier reply', async () => {
      // takeover → staff reply (2h ago) → Resume AI (1h ago) → inbound now
      h.state.conv = { ...h.state.conv, ai_resumed_at: hoursAgo(1) }
      h.state.messageRows = [row({ created_at: hoursAgo(2) })]
      await dispatchInboundToAiReply(ARGS)
      expect(h.state.outboundFilters).toContainEqual(['gte', 'created_at', hoursAgo(1)])
      expect(h.engineSendText).toHaveBeenCalledWith(
        expect.objectContaining({ aiGenerated: true }),
      )
    })

    it.each([
      ['a send after Resume AI', hoursAgo(1), hoursAgo(0.5)],
      ['a recent send when Resume AI is older than 24h', hoursAgo(30), hoursAgo(2)],
    ])('still skips on %s', async (_label, resumedAt, sentAt) => {
      h.state.conv = { ...h.state.conv, ai_resumed_at: resumedAt }
      h.state.messageRows = [row({ created_at: sentAt })]
      await dispatchInboundToAiReply(ARGS)
      expect(h.engineSendText).not.toHaveBeenCalled()
    })

    it('stands down without calling the model when the lookup errors', async () => {
      h.state.recentOutboundError = { message: 'boom' }
      await dispatchInboundToAiReply(ARGS)
      expect(h.generateReply).not.toHaveBeenCalled()
      expect(h.engineSendText).not.toHaveBeenCalled()
    })
  })

  it('skips when there is nothing to reply to', async () => {
    h.buildConversationContext.mockResolvedValue([])
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — handoff', () => {
  it('disables auto-reply, writes a summary, and does not send on handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain(
      'AI agent handed off',
    )
    // No handoff target configured → conversation left unassigned.
    expect(h.state.updatePayload).not.toHaveProperty('assigned_agent_id')
  })

  it('routes to the configured handoff agent on handoff', async () => {
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    h.generateReply.mockResolvedValue({ text: '', handoff: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })
})
