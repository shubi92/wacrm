import { describe, expect, it } from 'vitest'
import { inboundMedia, inboundVoiceNote } from './parse-message'

const base = { id: 'wamid.M1', from: '966500000000', timestamp: '1700000000' }
const file = { id: 'media-1', mime_type: 'x/y' }

describe('inboundMedia — which inbound messages the bot acknowledges', () => {
  it.each(['video', 'image', 'document'] as const)('picks up a %s, with or without a caption', (type) => {
    expect(inboundMedia({ ...base, type, [type]: file })).toEqual({ kind: type, caption: undefined })
    expect(inboundMedia({ ...base, type, [type]: { ...file, caption: ' how much? ' } })).toEqual({
      kind: type,
      caption: 'how much?',
    })
  })

  it('a document’s file name is not a caption', () => {
    const message = { ...base, type: 'document', document: { ...file, filename: 'plan.pdf' } }
    expect(inboundMedia(message)?.caption).toBeUndefined()
  })

  it.each([
    { type: 'text', text: { body: 'hi' } },
    { type: 'audio', audio: file },
    { type: 'sticker', sticker: file },
    { type: 'location', location: { latitude: 1, longitude: 2 } },
    { type: 'contacts' },
    { type: 'reaction', reaction: { message_id: 'm', emoji: '👍' } },
  ])('leaves $type alone', (m) => {
    expect(inboundMedia({ ...base, ...m })).toBeUndefined()
  })

  it('a voice note is still only a voice note', () => {
    const voice = { ...base, type: 'audio', audio: file }
    expect(inboundVoiceNote(voice, 'token')).toBeDefined()
    expect(inboundMedia(voice)).toBeUndefined()
  })
})
