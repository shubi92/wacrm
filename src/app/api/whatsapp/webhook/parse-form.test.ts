import { describe, expect, it } from 'vitest'

// A completed WhatsApp form (a Meta "WhatsApp Flow") arrives on the same
// webhook as every other message, as `interactive.nfm_reply`. Before
// this was handled it was stored as "[Interactive reply]" and every
// answer was lost.

const { parseMessageContent } = await import('./parse-message')

const base = { id: 'wamid.TEST', from: '966500000000', timestamp: '1700000000', type: 'interactive' }
const formReply = (response: unknown) => ({
  ...base,
  interactive: {
    type: 'nfm_reply' as const,
    nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify(response) },
  },
})

describe('parseMessageContent — submitted WhatsApp forms', () => {
  it('keeps the answers as readable text and passes the submission on', async () => {
    const result = await parseMessageContent(
      formReply({ form: 'furniture_moving', lang: 'en', name: 'Noura', move_type: 'between', from_city: 'riyadh', to_city: 'jeddah' }),
      'token'
    )
    expect(result.contentText).toContain('📋 Furniture moving form')
    expect(result.contentText).toContain('Move: Between two cities')
    expect(result.formSubmission?.lead.service).toBe('furniture_moving')
    // Not a button tap: nothing for a Flow or an automation to route on.
    expect(result.interactiveReplyId).toBeNull()
  })

  it('stores a form it cannot identify without treating it as a known one', async () => {
    const result = await parseMessageContent(formReply({ flow_token: 'unused', q1: 'yes' }), 'token')
    expect(result.contentText).toBe('📋 Form response\nq1: yes')
    expect(result.formSubmission).toBeNull()
  })

  it('still reads an ordinary button tap', async () => {
    const result = await parseMessageContent(
      { ...base, interactive: { type: 'button_reply', button_reply: { id: 'yes', title: 'Yes' } } },
      'token'
    )
    expect(result).toMatchObject({ contentText: 'Yes', interactiveReplyId: 'yes', formSubmission: null })
  })
})
