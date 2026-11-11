import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { AiConfig } from './types'

// Shared, hoisted mock state so the module mocks can close over it.
const h = vi.hoisted(() => ({
  loadAiConfig: vi.fn(),
  buildConversationContext: vi.fn(),
  retrieveKnowledge: vi.fn(),
  generateReply: vi.fn(),
  engineSendText: vi.fn(),
  transcribeInboundVoiceNote: vi.fn(),
  sendVoiceReply: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    // `messages` rows; the mock applies the query's real filters to them.
    messageRows: [] as Record<string, unknown>[],
    recentOutboundError: null as { message: string } | null,
    outboundFilters: [] as [string, string, unknown][],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    updateFilters: [] as [string, unknown][],
    handoffWon: true as boolean,
    rpcCalls: [] as { name: string; args: unknown }[],
    testNumbers: null as string[] | null,
    testNumbersError: null as { message: string } | null,
    contactPhone: '966500000000' as string | null,
  },
}))

vi.mock('./config', () => ({ loadAiConfig: h.loadAiConfig }))
vi.mock('./context', () => ({ buildConversationContext: h.buildConversationContext }))
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }))
vi.mock('./generate', () => ({ generateReply: h.generateReply }))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }))
vi.mock('./voice', () => ({
  transcribeInboundVoiceNote: h.transcribeInboundVoiceNote,
  sendVoiceReply: h.sendVoiceReply,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'ai_configs' || table === 'contacts') {
        // .select().eq().maybeSingle() → test numbers / the contact's phone
        const row =
          table === 'ai_configs'
            ? { auto_reply_test_numbers: h.state.testNumbers }
            : { phone: h.state.contactPhone }
        const error = table === 'ai_configs' ? h.state.testNumbersError : null
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve(error ? { data: null, error } : { data: row, error: null }),
        }
        return chain
      }
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
        // .update().eq('id').eq('ai_autoreply_disabled', false).select() —
        // `handoffWon` decides whether the guarded update matched a row.
        update: (payload: Record<string, unknown>) => {
          h.state.updatePayload = payload
          const chain = {
            eq: (col: string, val: unknown) => {
              h.state.updateFilters.push([col, val])
              return chain
            },
            is: (col: string, val: unknown) => {
              h.state.updateFilters.push([col, val])
              return chain
            },
            select: () =>
              Promise.resolve({
                data: h.state.handoffWon ? [{ id: 'conv-1' }] : [],
                error: null,
              }),
          }
          return chain
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
  h.state.updateFilters = []
  h.state.handoffWon = true
  h.state.rpcCalls = []
  h.state.testNumbers = null
  h.state.testNumbersError = null
  h.state.contactPhone = '966500000000'
  h.loadAiConfig.mockResolvedValue(aiConfig())
  h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'hi' }])
  h.retrieveKnowledge.mockResolvedValue([])
  h.generateReply.mockResolvedValue({ text: 'Hello!', handoff: false, tagged: true })
  h.engineSendText.mockResolvedValue({ whatsapp_message_id: 'm1' })
  h.transcribeInboundVoiceNote.mockReset()
  h.transcribeInboundVoiceNote.mockResolvedValue({ status: 'ok', text: 'كم سعر التأشيرة؟' })
  h.sendVoiceReply.mockReset()
  h.sendVoiceReply.mockResolvedValue(undefined)
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
        return { text: 'Hello!', handoff: false, tagged: true }
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
    h.generateReply.mockResolvedValue({ text: '', handoff: true, tagged: true })
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
    h.generateReply.mockResolvedValue({ text: '', handoff: true, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
  })

  it('sends the handoff message to the customer, then stays handed off', async () => {
    h.generateReply.mockResolvedValue({
      text: 'A colleague will contact you shortly.',
      handoff: true,
      tagged: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    // Guarded on: still bot-owned, unassigned, and not resumed since.
    expect(h.state.updateFilters).toContainEqual(['ai_autoreply_disabled', false])
    expect(h.state.updateFilters).toContainEqual(['assigned_agent_id', null])
    expect(h.state.updateFilters).toContainEqual(['ai_resumed_at', null])
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'A colleague will contact you shortly.',
        aiGenerated: true,
      }),
    )
    // A goodbye is not a regular reply: no slot is claimed.
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('does not send the handoff message when a concurrent handoff already won', async () => {
    h.state.handoffWon = false
    h.generateReply.mockResolvedValue({ text: 'A colleague will help.', handoff: true, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send the handoff message when a human replied during generation', async () => {
    h.generateReply.mockImplementation(async () => {
      h.state.messageRows.push({
        conversation_id: 'conv-1',
        sender_type: 'agent',
        ai_generated: false,
        created_at: new Date().toISOString(),
      })
      return { text: 'A colleague will help.', handoff: true, tagged: true }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('never sends untagged output (possible leaked reasoning); hands off instead', async () => {
    h.generateReply.mockResolvedValue({
      text: 'Customer asks the price; per the rules… السعر ٢٧٦',
      handoff: false,
      tagged: false,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.state.rpcCalls).toHaveLength(0)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
  })

  it('guards a stale handoff on the resume time it read', async () => {
    h.state.conv = { ...h.state.conv, ai_resumed_at: '2026-11-09T10:00:00.000Z' }
    h.generateReply.mockResolvedValue({ text: 'Bye', handoff: true, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updateFilters).toContainEqual(['ai_resumed_at', '2026-11-09T10:00:00.000Z'])
  })

  it('drops an ordinary reply when the thread was paused and resumed during generation', async () => {
    h.generateReply.mockImplementation(async () => {
      h.state.conv = { ...h.state.conv, ai_resumed_at: new Date().toISOString() }
      return { text: 'Hello!', handoff: false, tagged: true }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.rpcCalls).toHaveLength(0) // no fresh slot consumed
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send when the contact phone changed to an unlisted number during generation', async () => {
    h.state.testNumbers = ['966500000000']
    h.generateReply.mockImplementation(async () => {
      h.state.contactPhone = '966511111111'
      return { text: 'Hello!', handoff: false, tagged: true }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('does not send an ordinary reply when the thread was handed off during generation', async () => {
    h.generateReply.mockImplementation(async () => {
      // A racing inbound paused the thread after our eligibility read.
      h.state.conv = { ...h.state.conv, ai_autoreply_disabled: true }
      return { text: 'Hello!', handoff: false, tagged: true }
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — test numbers', () => {
  it('replies to everyone when no test numbers are set', async () => {
    h.state.testNumbers = []
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('replies to a listed test number, whatever format it was typed in', async () => {
    h.state.testNumbers = ['966500000000']
    h.state.contactPhone = '+966 50 000 0000'
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('stays silent for a number that is not on the test list', async () => {
    h.state.testNumbers = ['966511111111']
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('fails closed when the test-numbers lookup errors (migration missing)', async () => {
    h.state.testNumbersError = { message: 'column does not exist' }
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — voice notes', () => {
  const VOICE = {
    ...ARGS,
    voiceNote: { mediaId: 'media-1', whatsappMessageId: 'wamid.V1', accessToken: 'token' },
  }

  it('a typed message never touches the voice path', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.transcribeInboundVoiceNote).not.toHaveBeenCalled()
    expect(h.sendVoiceReply).not.toHaveBeenCalled()
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('a transcribed voice note reaches the bot like typed text, and is answered in text then voice', async () => {
    const order: string[] = []
    h.transcribeInboundVoiceNote.mockImplementation(async () => {
      order.push('transcribe')
      return { status: 'ok', text: 'كم سعر التأشيرة؟' }
    })
    h.buildConversationContext.mockImplementation(async () => {
      order.push('context')
      return [{ role: 'user', content: 'كم سعر التأشيرة؟' }]
    })
    h.engineSendText.mockImplementation(async () => {
      order.push('text')
      return { whatsapp_message_id: 'm1' }
    })
    h.sendVoiceReply.mockImplementation(async () => {
      order.push('voice')
    })

    await dispatchInboundToAiReply(VOICE)

    expect(h.transcribeInboundVoiceNote).toHaveBeenCalledWith(
      expect.anything(),
      { accountId: 'acct-1', conversationId: 'conv-1', voiceNote: VOICE.voiceNote },
    )
    expect(h.generateReply.mock.calls[0][0].messages).toEqual([
      { role: 'user', content: 'كم سعر التأشيرة؟' },
    ])
    // Transcript is saved before the context is read; text goes out before audio.
    expect(order).toEqual(['transcribe', 'context', 'text', 'voice'])
    expect(h.sendVoiceReply).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ conversationId: 'conv-1', text: 'Hello!' }),
    )
    expect(h.state.updatePayload).toBeNull() // no handoff
  })

  it('hands off to a person when the voice note cannot be turned into text', async () => {
    h.transcribeInboundVoiceNote.mockResolvedValue({
      status: 'failed',
      reason: 'the voice note is longer than 3 minutes.',
    })
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))

    await dispatchInboundToAiReply(VOICE)

    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('longer than 3 minutes')
    // Same race guards as a model handoff.
    expect(h.state.updateFilters).toEqual(
      expect.arrayContaining([
        ['ai_autoreply_disabled', false],
        ['assigned_agent_id', null],
      ]),
    )
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendVoiceReply).not.toHaveBeenCalled()
  })

  it('stays silent, as before, when voice transcription is switched off', async () => {
    h.transcribeInboundVoiceNote.mockResolvedValue({ status: 'off' })
    await dispatchInboundToAiReply(VOICE)
    expect(h.state.updatePayload).toBeNull()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('never sends audio out for a contact that is not a test number', async () => {
    h.state.testNumbers = ['966511111111']
    await dispatchInboundToAiReply(VOICE)
    expect(h.transcribeInboundVoiceNote).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it.each([
    ['a human is assigned', { assigned_agent_id: 'agent-9', ai_autoreply_disabled: false, ai_reply_count: 0 }],
    ['the bot is paused on the thread', { assigned_agent_id: null, ai_autoreply_disabled: true, ai_reply_count: 0 }],
    ['the reply cap is reached', { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }],
  ])('does not listen when %s', async (_label, conv) => {
    h.state.conv = conv
    await dispatchInboundToAiReply(VOICE)
    expect(h.transcribeInboundVoiceNote).not.toHaveBeenCalled()
  })

  it('does not listen when a teammate is already talking to the customer', async () => {
    h.state.messageRows = [
      {
        conversation_id: 'conv-1',
        sender_type: 'agent',
        ai_generated: false,
        created_at: new Date().toISOString(),
      },
    ]
    await dispatchInboundToAiReply(VOICE)
    expect(h.transcribeInboundVoiceNote).not.toHaveBeenCalled()
  })

  it('does not speak a handoff goodbye — text only', async () => {
    h.generateReply.mockResolvedValue({ text: 'A colleague will help.', handoff: true, tagged: true })
    await dispatchInboundToAiReply(VOICE)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.sendVoiceReply).not.toHaveBeenCalled()
  })

  it('does not speak when the text reply itself was not sent', async () => {
    h.state.claim = false // lost the reply-cap race
    await dispatchInboundToAiReply(VOICE)
    expect(h.engineSendText).not.toHaveBeenCalled()
    expect(h.sendVoiceReply).not.toHaveBeenCalled()
  })
})
