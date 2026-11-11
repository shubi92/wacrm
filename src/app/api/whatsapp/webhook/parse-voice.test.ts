import { describe, expect, it } from 'vitest'
import { inboundVoiceNote } from './parse-message'

const base = { id: 'wamid.V1', from: '966500000000', timestamp: '1700000000' }

describe('inboundVoiceNote — which inbound messages the bot listens to', () => {
  it('picks up an audio message with its media id, wamid and token', () => {
    expect(
      inboundVoiceNote(
        { ...base, type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus' } },
        'token',
      ),
    ).toEqual({ mediaId: 'media-1', whatsappMessageId: 'wamid.V1', accessToken: 'token' })
  })

  it('ignores typed text and other media', () => {
    expect(inboundVoiceNote({ ...base, type: 'text', text: { body: 'hi' } }, 'token')).toBeUndefined()
    expect(
      inboundVoiceNote({ ...base, type: 'image', image: { id: 'm', mime_type: 'image/png' } }, 'token'),
    ).toBeUndefined()
  })

  it('ignores an audio message that arrived without a media id', () => {
    expect(inboundVoiceNote({ ...base, type: 'audio' }, 'token')).toBeUndefined()
  })
})
