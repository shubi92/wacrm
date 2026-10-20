import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// Meta delivers a QUICK_REPLY tap on a *template* as `type: "button"` with a
// flat `button: { text, payload }` — NOT as `interactive.button_reply`, which
// is only used for interactive messages we compose ourselves.
//
// The webhook originally handled only the latter, so template taps fell to the
// `default:` branch and were stored as "[Unsupported message type: button]".
// Any consumer scoring a survey reply (e.g. a CSAT flow keyed on
// Excellent / Good / Needs Improvement) saw that placeholder instead of the
// label, and the rating was lost with no error raised anywhere.
// ---------------------------------------------------------------------------

const { parseMessageContent } = await import('./parse-message')

const base = { id: 'wamid.TEST', from: '966500000000', timestamp: '1700000000' }

describe('parseMessageContent — template button taps', () => {
  it('keeps the visible label as the message text', async () => {
    const result = await parseMessageContent(
      { ...base, type: 'button', button: { text: 'ممتاز', payload: 'excellent' } },
      'token'
    )

    expect(result.contentText).toBe('ممتاز')
    expect(result.contentText).not.toMatch(/Unsupported/)
  })

  it('exposes the payload as the stable reply id', async () => {
    const result = await parseMessageContent(
      { ...base, type: 'button', button: { text: 'Needs Improvement', payload: 'needs_improvement' } },
      'token'
    )

    // Labels are operator-editable; the payload is what was registered with
    // Meta, so routing logic should be able to key on it.
    expect(result.interactiveReplyId).toBe('needs_improvement')
  })

  it('falls back to the label when Meta omits the payload', async () => {
    const result = await parseMessageContent(
      { ...base, type: 'button', button: { text: 'Good' } },
      'token'
    )

    expect(result.contentText).toBe('Good')
    expect(result.interactiveReplyId).toBe('Good')
  })

  it('degrades to a marker rather than throwing on an empty button', async () => {
    const result = await parseMessageContent(
      { ...base, type: 'button', button: {} },
      'token'
    )

    expect(result.contentText).toBe('[Button reply]')
  })

  it('still handles interactive replies from our own messages', async () => {
    const result = await parseMessageContent(
      {
        ...base,
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'existing_customer', title: 'Existing customer' },
        },
      },
      'token'
    )

    expect(result.contentText).toBe('Existing customer')
    expect(result.interactiveReplyId).toBe('existing_customer')
  })
})
