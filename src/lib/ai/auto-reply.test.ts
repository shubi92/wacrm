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
  dispatchWebhookEvent: vi.fn(),
  state: {
    conv: null as Record<string, unknown> | null,
    autoResponders: [] as { id: string }[],
    // `messages` rows; the mock applies the query's real filters to them.
    messageRows: [] as Record<string, unknown>[],
    recentOutboundError: null as { message: string } | null,
    outboundFilters: [] as [string, string, unknown][],
    claim: true as boolean,
    updatePayload: null as Record<string, unknown> | null,
    updatePayloads: [] as Record<string, unknown>[],
    updateFilters: [] as [string, unknown][],
    handoffWon: true as boolean,
    rpcCalls: [] as { name: string; args: unknown }[],
    testNumbers: null as string[] | null,
    testNumbersError: null as { message: string } | null,
    contactPhone: '966500000000' as string | null,
    contactName: 'Sara' as string | null,
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
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: h.dispatchWebhookEvent,
}))
vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === 'ai_configs' || table === 'contacts') {
        // .select().eq().maybeSingle() → test numbers / the contact's phone
        const row =
          table === 'ai_configs'
            ? { auto_reply_test_numbers: h.state.testNumbers }
            : { phone: h.state.contactPhone, name: h.state.contactName }
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
          h.state.updatePayloads.push(payload)
          const chain = {
            eq: (col: string, val: unknown) => {
              h.state.updateFilters.push([col, val])
              return chain
            },
            is: (col: string, val: unknown) => {
              h.state.updateFilters.push([col, val])
              return chain
            },
            select: () => {
              // A winning update really changes the row, so a re-read sees it.
              if (h.state.handoffWon && h.state.conv) {
                h.state.conv = { ...h.state.conv, ...payload }
              }
              return Promise.resolve({
                data: h.state.handoffWon ? [{ id: 'conv-1' }] : [],
                error: null,
              })
            },
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
import { __resetRateLimitForTests } from '@/lib/rate-limit'

const ARGS = {
  accountId: 'acct-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  configOwnerUserId: 'user-1',
}

/** The standard line a customer gets when the bot hands off wordlessly. */
const EN_LINE = 'Your request has been passed to our team and they will contact you shortly.'
const AR_LINE = 'تم تحويل طلبك إلى فريقنا وسيتواصلون معك قريباً.'
const sentTexts = () => h.engineSendText.mock.calls.map((c) => c[0].text)
/** A `messages` row sent to the customer on this chat `hours` ago. */
const sentHoursAgo = (hours: number, overrides: Record<string, unknown> = {}) => ({
  conversation_id: 'conv-1',
  sender_type: 'bot',
  ai_generated: true,
  created_at: new Date(Date.now() - hours * 3_600_000).toISOString(),
  ...overrides,
})

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
  __resetRateLimitForTests()
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
  h.state.updatePayloads = []
  h.state.updateFilters = []
  h.state.handoffWon = true
  h.state.rpcCalls = []
  h.state.testNumbers = null
  h.state.testNumbersError = null
  h.state.contactPhone = '966500000000'
  h.state.contactName = 'Sara'
  h.dispatchWebhookEvent.mockReset()
  h.dispatchWebhookEvent.mockResolvedValue(undefined)
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

  it('sends no further reply of its own once the per-conversation cap is reached', async () => {
    h.state.conv = {
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
      ai_reply_count: 3,
    }
    h.state.messageRows = [sentHoursAgo(1)]
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual([EN_LINE]) // never the model's "Hello!"
    expect(h.state.rpcCalls).toHaveLength(0)
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
  it('disables auto-reply, writes a summary, and tells the customer on a wordless handoff', async () => {
    h.generateReply.mockResolvedValue({ text: '', handoff: true, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual([EN_LINE])
    expect(h.engineSendText).toHaveBeenCalledWith(expect.objectContaining({ aiGenerated: true }))
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
      raw: 'Customer asks the price; per the rules… السعر ٢٧٦',
      retried: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual([EN_LINE]) // the standard line, never the untagged text
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

describe('dispatchInboundToAiReply — conversation.handed_off webhook', () => {
  const LEAD = {
    service: 'ac_cleaning',
    details: [{ question: 'كم عدد المكيفات؟', answer: '3' }],
    quoted_price_sar: 300,
    customer_name: 'سارة',
    area: 'الرياض، حي الملقا',
    preferred_date: 'يوم الخميس',
  }
  const AT_CAP = { assigned_agent_id: null, ai_autoreply_disabled: false, ai_reply_count: 3 }
  const event = () => h.dispatchWebhookEvent.mock.calls[0]?.[3] as Record<string, unknown>

  it('a customer who said yes: one event with the lead, and only the goodbye reaches the customer', async () => {
    h.state.contactPhone = '+966 50 000 0000'
    h.generateReply.mockResolvedValue({
      text: 'تم، سيتواصل معك أحد الزملاء.',
      handoff: true,
      lead: LEAD,
      ready: true,
      leadUnreadable: false,
      tagged: true,
    })
    await dispatchInboundToAiReply(ARGS)

    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledWith(
      expect.anything(),
      'acct-1',
      'conversation.handed_off',
      {
        conversation_id: 'conv-1',
        contact: { id: 'contact-1', phone: '966500000000', name: 'Sara' },
        reason: 'customer_ready',
        summary: h.state.updatePayload?.ai_handoff_summary,
        handed_off_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT[\d:.]+Z$/),
        lead: LEAD,
      },
    )
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('Customer is ready: ac cleaning, quoted 300 SAR')

    // The customer gets the goodbye and nothing else.
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.engineSendText.mock.calls[0][0].text).toBe('تم، سيتواصل معك أحد الزملاء.')
  })

  it('a handoff without a yes still passes on what the bot collected (the rep prices it)', async () => {
    h.generateReply.mockResolvedValue({
      text: 'سيتواصل معك أحد الزملاء لتحديد السعر.',
      handoff: true,
      lead: { ...LEAD, service: 'villa_cleaning', quoted_price_sar: null },
      ready: false,
      leadUnreadable: false,
      tagged: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({
      reason: 'bot_cannot_help',
      lead: { ...LEAD, service: 'villa_cleaning', quoted_price_sar: null },
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('Collected so far: villa cleaning')
    expect(h.state.updatePayload?.ai_handoff_summary).not.toContain('Customer is ready')
  })

  it('details survive output that could not be sent: reason other, lead kept', async () => {
    h.generateReply.mockResolvedValue({ text: 'x', handoff: false, lead: LEAD, ready: false, leadUnreadable: false, tagged: false })
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ reason: 'other', lead: LEAD })
  })

  it('details the model wrote on an ordinary turn are ignored: no handoff, no event', async () => {
    h.generateReply.mockResolvedValue({ text: 'كم عدد المكيفات؟', handoff: false, lead: LEAD, ready: false, leadUnreadable: false, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual(['كم عدد المكيفات؟'])
    expect(h.state.updatePayload).toBeNull()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('a plain model handoff reports bot_cannot_help with no lead', async () => {
    h.state.contactName = null
    h.generateReply.mockResolvedValue({ text: '', handoff: true, lead: null, leadUnreadable: false, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({
      reason: 'bot_cannot_help',
      lead: null,
      contact: { id: 'contact-1', phone: '966500000000', name: null },
    })
  })

  it('an unreadable lead block is still a handoff — plain, flagged in the note, lead null', async () => {
    h.generateReply.mockResolvedValue({
      text: 'سيتواصل معك أحد الزملاء.',
      handoff: true,
      lead: null,
      leadUnreadable: true,
      tagged: true,
    })
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('could not be read')
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({ reason: 'other', lead: null })
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
  })

  it('output that cannot be sent (untagged) reports other', async () => {
    h.generateReply.mockResolvedValue({ text: 'x', handoff: false, lead: null, leadUnreadable: false, tagged: false, raw: 'x', retried: true })
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ reason: 'other', lead: null })
    expect(sentTexts()).toEqual([EN_LINE])
    // The owner can see it was a fault, that a second try ran, and what was written.
    const note = String(h.state.updatePayload?.ai_handoff_summary)
    expect(note).toContain('did not choose this')
    expect(note).toContain('even on a second try')
    expect(note).toContain('It wrote: “x”')
  })

  it('a bare [[HANDOFF]] is reported as the bot\'s own choice, and the customer still gets the standard line', async () => {
    h.buildConversationContext.mockResolvedValue([{ role: 'user', content: 'وش الخدمات اللي عندكم؟' }])
    h.generateReply.mockResolvedValue({ text: '', handoff: true, lead: null, leadUnreadable: false, tagged: false, raw: '[[HANDOFF]]', retried: false })
    await dispatchInboundToAiReply(ARGS)
    expect(event()).toMatchObject({ reason: 'bot_cannot_help', lead: null })
    expect(sentTexts()).toEqual([AR_LINE])
    const note = String(h.state.updatePayload?.ai_handoff_summary)
    expect(note).toContain('The bot chose to hand off.')
    expect(note).not.toContain('did not choose this')
  })

  it('reports voice_note_failed when a voice note cannot be understood', async () => {
    h.transcribeInboundVoiceNote.mockResolvedValue({ status: 'failed', reason: 'no speech could be made out in the voice note.' })
    await dispatchInboundToAiReply({
      ...ARGS,
      voiceNote: { mediaId: 'media-1', whatsappMessageId: 'wamid.1', accessToken: 'token' },
    })
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({ reason: 'voice_note_failed', lead: null })
    expect(String(event().summary)).toContain('no speech')
  })

  it('at the reply cap: withholds the reply, hands off to a person and reports reply_cap', async () => {
    h.state.conv = AT_CAP
    h.state.messageRows = [sentHoursAgo(1)]
    h.loadAiConfig.mockResolvedValue(aiConfig({ handoffAgentId: 'agent-7' }))
    await dispatchInboundToAiReply(ARGS) // the model answers "Hello!" as usual
    expect(h.state.updatePayload).toMatchObject({
      ai_autoreply_disabled: true,
      assigned_agent_id: 'agent-7',
    })
    expect(h.state.updatePayload?.ai_handoff_summary).toContain('limit of 3 replies')
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({ reason: 'reply_cap', lead: null })
    expect(sentTexts()).toEqual([EN_LINE])
    expect(h.state.rpcCalls).toHaveLength(0)
  })

  it('at the reply cap: a customer who says yes is still handed over with their details', async () => {
    h.state.conv = AT_CAP
    h.state.messageRows = [sentHoursAgo(1)]
    h.generateReply.mockResolvedValue({ text: 'تم', handoff: true, lead: LEAD, ready: true, leadUnreadable: false, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({ reason: 'customer_ready', lead: LEAD })
    expect(h.engineSendText.mock.calls.map((c) => c[0].text)).toEqual(['تم'])
  })

  it('reports the number WhatsApp gave, not however the contact was typed in', async () => {
    h.state.contactPhone = '0501234567'
    h.generateReply.mockResolvedValue({ text: '', handoff: true, lead: null, leadUnreadable: false, tagged: true })
    await dispatchInboundToAiReply({ ...ARGS, fromPhone: '966501234567' })
    expect(event()).toMatchObject({ contact: { phone: '966501234567' } })
  })

  it('at the reply cap with a teammate already talking: stays out of it', async () => {
    h.state.conv = AT_CAP
    h.state.messageRows = [
      {
        conversation_id: 'conv-1',
        sender_type: 'agent',
        ai_generated: false,
        created_at: new Date().toISOString(),
      },
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('fires nothing when another inbound already won the handoff', async () => {
    h.state.handoffWon = false
    h.generateReply.mockResolvedValue({ text: 'bye', handoff: true, lead: LEAD, ready: true, leadUnreadable: false, tagged: true })
    await dispatchInboundToAiReply(ARGS)
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('fires nothing on an ordinary reply', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).toHaveBeenCalledTimes(1)
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
  })

  it('still reports the handoff when sending the goodbye fails', async () => {
    h.generateReply.mockResolvedValue({ text: 'bye', handoff: true, lead: LEAD, ready: true, leadUnreadable: false, tagged: true })
    h.engineSendText.mockRejectedValue(new Error('Meta is down'))
    await dispatchInboundToAiReply(ARGS)
    expect(h.dispatchWebhookEvent).toHaveBeenCalledTimes(1)
    expect(event()).toMatchObject({ reason: 'customer_ready', lead: LEAD })
  })

  it.each([
    ['a ready customer', () => h.generateReply.mockResolvedValue({ text: 'bye', handoff: true, lead: LEAD, ready: true, leadUnreadable: false, tagged: true })],
    ['the reply cap', () => { h.state.conv = AT_CAP }],
  ])('test mode holds: nothing fires for a number off the test list (%s)', async (_label, arrange) => {
    arrange()
    h.state.testNumbers = ['966511111111']
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull()
    expect(h.dispatchWebhookEvent).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — a handoff is never silent', () => {
  const bare = { text: '', handoff: true, lead: null, leadUnreadable: false, tagged: true }

  it('answers in Arabic when the customer wrote in Arabic', async () => {
    h.buildConversationContext.mockResolvedValue([
      { role: 'user', content: 'السلام عليكم' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'كم سعر تنظيف المكيف؟' },
    ])
    h.generateReply.mockResolvedValue(bare)
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual([AR_LINE])
  })

  it('keeps the model’s own goodbye when it wrote one', async () => {
    h.generateReply.mockResolvedValue({ ...bare, text: 'A colleague will call you.' })
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual(['A colleague will call you.'])
  })

  it('a wordless handoff leaves a note that says the bot chose it', async () => {
    h.generateReply.mockResolvedValue(bare)
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload?.ai_handoff_summary).not.toContain('did not choose this')
  })

  it.each([
    ['another inbound already won the handoff', () => { h.state.handoffWon = false }],
    ['the contact is no longer on the test list', () => {
      // On the list when the message arrived, edited off it before the send.
      h.state.testNumbers = ['966500000000']
      h.generateReply.mockImplementation(async () => {
        h.state.contactPhone = '966599999999'
        return bare
      })
    }],
    ['a teammate replied while the model was thinking', () => {
      h.generateReply.mockImplementation(async () => {
        h.state.messageRows = [
          { conversation_id: 'conv-1', sender_type: 'agent', ai_generated: false, created_at: new Date().toISOString() },
        ]
        return bare
      })
    }],
  ])('sends nothing when %s', async (_label, arrange) => {
    h.generateReply.mockResolvedValue(bare)
    arrange()
    await dispatchInboundToAiReply(ARGS)
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('stays out of a voice note it could not understand (a person must listen first)', async () => {
    h.transcribeInboundVoiceNote.mockResolvedValue({ status: 'failed', reason: 'no speech could be made out in the voice note.' })
    await dispatchInboundToAiReply({
      ...ARGS,
      voiceNote: { mediaId: 'media-1', whatsappMessageId: 'wamid.1', accessToken: 'token' },
    })
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('is sent as text only, even when the customer spoke', async () => {
    h.generateReply.mockResolvedValue(bare)
    await dispatchInboundToAiReply({
      ...ARGS,
      voiceNote: { mediaId: 'media-1', whatsappMessageId: 'wamid.1', accessToken: 'token' },
    })
    expect(sentTexts()).toHaveLength(1)
    expect(h.sendVoiceReply).not.toHaveBeenCalled()
  })
})

describe('dispatchInboundToAiReply — after Resume AI', () => {
  const prompt = () => h.generateReply.mock.calls[0][0].systemPrompt as string

  it('tells the model it has been switched back on, so an old handoff in the history does not repeat', async () => {
    h.state.conv = { ...h.state.conv, ai_resumed_at: '2026-11-11T20:10:00.000Z' }
    await dispatchInboundToAiReply(ARGS)
    expect(prompt()).toContain('switched you back on')
  })

  it('says nothing of the kind on a thread that was never handed off', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(prompt()).not.toContain('switched you back on')
  })
})

describe('dispatchInboundToAiReply — a quiet day starts the chat over', () => {
  const CAP_NOTE = '🤖 AI agent handed off: it reached its limit of 3 replies on this chat. Please take over.'
  /** Paused by the reply cap, nobody assigned. */
  const CAPPED = {
    assigned_agent_id: null,
    ai_autoreply_disabled: true,
    ai_reply_count: 3,
    ai_handoff_summary: CAP_NOTE,
    ai_resumed_at: null,
  }
  const untouched = () => {
    expect(h.state.updatePayload).toBeNull()
    expect(h.generateReply).not.toHaveBeenCalled()
    expect(h.engineSendText).not.toHaveBeenCalled()
  }

  it('a capped chat: the customer returns after 24 quiet hours and gets an answer', async () => {
    h.state.conv = CAPPED
    h.state.messageRows = [sentHoursAgo(25)] // the bot's goodbye
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayloads).toEqual([
      {
        ai_autoreply_disabled: false,
        ai_reply_count: 0,
        ai_handoff_summary: null,
        ai_resumed_at: expect.any(String),
      },
    ])
    // Only while still paused, unassigned and not resumed by anyone else.
    expect(h.state.updateFilters).toEqual([
      ['id', 'conv-1'],
      ['ai_autoreply_disabled', true],
      ['assigned_agent_id', null],
      ['ai_resumed_at', null],
    ])
    expect(h.state.rpcCalls).toHaveLength(1) // a slot of the fresh budget
    expect(sentTexts()).toEqual(['Hello!'])
  })

  it('a capped chat: the customer returns after 2 hours and the bot stays paused', async () => {
    h.state.conv = CAPPED
    h.state.messageRows = [sentHoursAgo(2)]
    await dispatchInboundToAiReply(ARGS)
    untouched()
  })

  it('a capped chat: a teammate replied inside the 24 hours, so the bot stays paused', async () => {
    h.state.conv = CAPPED
    h.state.messageRows = [
      sentHoursAgo(30),
      sentHoursAgo(3, { sender_type: 'agent', ai_generated: false }),
    ]
    await dispatchInboundToAiReply(ARGS)
    untouched()
  })

  it('the customer writing again while waiting does not keep the bot locked out', async () => {
    h.state.conv = CAPPED
    h.state.messageRows = [
      sentHoursAgo(25),
      sentHoursAgo(10, { sender_type: 'customer', ai_generated: false }),
      sentHoursAgo(1, { sender_type: 'customer', ai_generated: false }),
    ]
    await dispatchInboundToAiReply(ARGS)
    expect(sentTexts()).toEqual(['Hello!'])
  })

  it.each([
    ['the bot could not help', '🤖 AI agent handed off after 2 replies. The bot chose to hand off.'],
    ['the customer is ready', '🤖 AI agent handed off after 2 replies. Customer is ready: ac cleaning, quoted 300 SAR.'],
    ['a person paused it (no note)', null],
  ])('a pause the cap did not cause is never lifted: %s', async (_label, note) => {
    h.state.conv = { ...CAPPED, ai_handoff_summary: note }
    h.state.messageRows = [sentHoursAgo(72)]
    await dispatchInboundToAiReply(ARGS)
    untouched()
  })

  it('a capped chat a person is assigned to stays with that person', async () => {
    h.state.conv = { ...CAPPED, assigned_agent_id: 'agent-7' }
    h.state.messageRows = [sentHoursAgo(72)]
    await dispatchInboundToAiReply(ARGS)
    untouched()
  })

  it('a chat at its cap but not paused: answered after a quiet day instead of handed off', async () => {
    h.state.conv = { ...CAPPED, ai_autoreply_disabled: false, ai_handoff_summary: null }
    h.state.messageRows = [sentHoursAgo(48)]
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayloads).toHaveLength(1)
    expect(h.state.updatePayloads[0]).toMatchObject({ ai_reply_count: 0 })
    expect(sentTexts()).toEqual(['Hello!'])
  })

  it('never a second fresh budget inside the same 24 hours', async () => {
    // Started over an hour ago and already used up: a reply still on its
    // way (claimed, not yet stored) must not let the chat start over again.
    h.state.conv = {
      ...CAPPED,
      ai_autoreply_disabled: false,
      ai_handoff_summary: null,
      ai_resumed_at: new Date(Date.now() - 3_600_000).toISOString(),
    }
    h.state.messageRows = []
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toMatchObject({ ai_autoreply_disabled: true })
    expect(h.state.updatePayload?.ai_handoff_summary).toBe(CAP_NOTE)
    expect(sentTexts()).toEqual([EN_LINE])
  })

  it('loses the race to another inbound: carries on from what is really there', async () => {
    h.state.conv = CAPPED
    h.state.messageRows = [sentHoursAgo(25)]
    h.state.handoffWon = false // the guarded update matched no row
    await dispatchInboundToAiReply(ARGS)
    expect(h.generateReply).not.toHaveBeenCalled() // still paused on re-read
    expect(h.engineSendText).not.toHaveBeenCalled()
  })

  it('leaves a new chat alone (nothing to reset, no extra lookup)', async () => {
    await dispatchInboundToAiReply(ARGS)
    expect(h.state.updatePayload).toBeNull()
    expect(h.state.outboundFilters.filter(([, col]) => col === 'ai_generated')).toHaveLength(
      h.state.outboundFilters.filter(([op]) => op === 'gte').length,
    ) // every messages lookup was the "others active" one
  })
})
