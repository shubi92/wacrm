import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { AiError, type VoiceConfig } from './types'

// No real Gemini / ElevenLabs / Meta / storage call is made anywhere here.
const h = vi.hoisted(() => ({
  loadVoiceConfig: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  inspectOggOpus: vi.fn(),
  transcribeAudio: vi.fn(),
  synthesizeSpeech: vi.fn(),
  engineSendMedia: vi.fn(),
}))

vi.mock('./config', () => ({ loadVoiceConfig: h.loadVoiceConfig }))
vi.mock('./ogg', () => ({ inspectOggOpus: h.inspectOggOpus }))
vi.mock('./providers/gemini', () => ({ transcribeAudio: h.transcribeAudio }))
vi.mock('./providers/elevenlabs', () => ({
  synthesizeSpeech: h.synthesizeSpeech,
  ELEVENLABS_OPUS_FORMAT: 'opus-test',
  ELEVENLABS_MP3_FORMAT: 'mp3-test',
}))
vi.mock('@/lib/whatsapp/meta-api', () => ({
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}))
vi.mock('@/lib/flows/meta-send', () => ({ engineSendMedia: h.engineSendMedia }))

import {
  MAX_VOICE_NOTE_BYTES,
  MAX_VOICE_NOTE_SECONDS,
  sendVoiceReply,
  toSpeakableText,
  transcribeInboundVoiceNote,
} from './voice'

function voiceConfig(overrides: Partial<VoiceConfig> = {}): VoiceConfig {
  return {
    transcriptionEnabled: true,
    replyEnabled: true,
    geminiApiKey: 'gemini-test',
    elevenLabsApiKey: 'eleven-test',
    elevenLabsVoiceId: 'voice-1',
    ...overrides,
  }
}

const db = {
  saved: [] as { payload: unknown; filters: [string, unknown][] }[],
  saveError: null as { message: string } | null,
  uploads: [] as { path: string; bytes: Uint8Array; contentType: string }[],
  uploadError: null as { message: string } | null,
}

function fakeDb(): SupabaseClient {
  return {
    from: () => ({
      update: (payload: unknown) => {
        const filters: [string, unknown][] = []
        const chain = {
          eq: (col: string, val: unknown) => {
            filters.push([col, val])
            return chain
          },
          then: (resolve: (v: { error: unknown }) => void) => {
            db.saved.push({ payload, filters })
            resolve({ error: db.saveError })
          },
        }
        return chain
      },
    }),
    storage: {
      from: () => ({
        upload: async (path: string, bytes: Uint8Array, opts: { contentType: string }) => {
          db.uploads.push({ path, bytes, contentType: opts.contentType })
          return { error: db.uploadError }
        },
        getPublicUrl: (path: string) => ({
          data: { publicUrl: `https://storage.test/chat-media/${path}` },
        }),
      }),
    },
  } as unknown as SupabaseClient
}

const NOTE = { mediaId: 'media-1', whatsappMessageId: 'wamid.V1', accessToken: 'wa-token' }
const LISTEN = { accountId: 'acct-1', conversationId: 'conv-1', voiceNote: NOTE }
const SPEAK = {
  accountId: 'acct-1',
  userId: 'user-1',
  conversationId: 'conv-1',
  contactId: 'contact-1',
  text: 'السعر *300* ريال 🙂 https://example.com/visa',
}
const OGG_MONO = { isOggOpus: true, channels: 1, durationSeconds: 12 }
const NOT_OGG = { isOggOpus: false, channels: null, durationSeconds: null }

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  db.saved = []
  db.saveError = null
  db.uploads = []
  db.uploadError = null
  h.loadVoiceConfig.mockResolvedValue(voiceConfig())
  h.getMediaUrl.mockResolvedValue({ url: 'https://meta.test/m', mimeType: 'audio/ogg; codecs=opus' })
  h.downloadMedia.mockResolvedValue({ buffer: Buffer.from('audio'), contentType: 'audio/ogg' })
  h.inspectOggOpus.mockReturnValue(OGG_MONO)
  h.transcribeAudio.mockResolvedValue('  كم سعر التأشيرة؟  ')
  h.synthesizeSpeech.mockResolvedValue(new Uint8Array([1, 2, 3]))
  h.engineSendMedia.mockResolvedValue({ whatsapp_message_id: 'wamid.OUT' })
})

describe('transcribeInboundVoiceNote', () => {
  it('saves the transcript on the audio message and returns it', async () => {
    const out = await transcribeInboundVoiceNote(fakeDb(), LISTEN)

    expect(out).toEqual({ status: 'ok', text: 'كم سعر التأشيرة؟' })
    expect(h.transcribeAudio).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: 'gemini-test', mimeType: 'audio/ogg' }),
    )
    // Only the text is written — content_type stays 'audio' so the inbox still plays it.
    expect(db.saved).toEqual([
      {
        payload: { content_text: 'كم سعر التأشيرة؟' },
        filters: [
          ['conversation_id', 'conv-1'],
          ['message_id', 'wamid.V1'],
        ],
      },
    ])
  })

  it('is off — and downloads nothing — when the switch is off', async () => {
    h.loadVoiceConfig.mockResolvedValue(voiceConfig({ transcriptionEnabled: false }))
    expect(await transcribeInboundVoiceNote(fakeDb(), LISTEN)).toEqual({ status: 'off' })
    expect(h.getMediaUrl).not.toHaveBeenCalled()
    expect(h.transcribeAudio).not.toHaveBeenCalled()
  })

  it(`fails without calling Gemini when the note is longer than ${MAX_VOICE_NOTE_SECONDS}s`, async () => {
    h.inspectOggOpus.mockReturnValue({ ...OGG_MONO, durationSeconds: MAX_VOICE_NOTE_SECONDS + 1 })
    const out = await transcribeInboundVoiceNote(fakeDb(), LISTEN)
    expect(out).toMatchObject({ status: 'failed' })
    expect((out as { reason: string }).reason).toContain('longer than 3 minutes')
    expect(h.transcribeAudio).not.toHaveBeenCalled()
  })

  it('falls back to a size cap when the length cannot be read', async () => {
    h.inspectOggOpus.mockReturnValue(NOT_OGG)
    h.downloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(MAX_VOICE_NOTE_BYTES + 1),
      contentType: 'audio/mpeg',
    })
    expect(await transcribeInboundVoiceNote(fakeDb(), LISTEN)).toMatchObject({ status: 'failed' })
    expect(h.transcribeAudio).not.toHaveBeenCalled()
  })

  it('applies the size cap even when the file claims to be short', async () => {
    h.inspectOggOpus.mockReturnValue({ ...OGG_MONO, durationSeconds: 5 })
    h.downloadMedia.mockResolvedValue({
      buffer: Buffer.alloc(MAX_VOICE_NOTE_BYTES + 1),
      contentType: 'audio/ogg',
    })
    expect(await transcribeInboundVoiceNote(fakeDb(), LISTEN)).toMatchObject({ status: 'failed' })
    expect(h.transcribeAudio).not.toHaveBeenCalled()
  })

  it('fails when the transcript comes back empty', async () => {
    h.transcribeAudio.mockResolvedValue('  ')
    const out = await transcribeInboundVoiceNote(fakeDb(), LISTEN)
    expect(out).toMatchObject({ status: 'failed' })
    expect(db.saved).toEqual([])
  })

  it.each([
    ['Gemini times out', () => h.transcribeAudio.mockRejectedValue(new AiError('slow', { code: 'timeout' }))],
    ['Gemini errors', () => h.transcribeAudio.mockRejectedValue(new AiError('boom'))],
    ['the audio cannot be downloaded', () => h.downloadMedia.mockRejectedValue(new Error('404'))],
    ['the transcript cannot be saved', () => { db.saveError = { message: 'db down' } }],
    ['the settings cannot be read', () => h.loadVoiceConfig.mockRejectedValue(new Error('x'))],
  ])('reports failure instead of throwing when %s', async (_label, arrange) => {
    arrange()
    await expect(transcribeInboundVoiceNote(fakeDb(), LISTEN)).resolves.toMatchObject({
      status: 'failed',
    })
  })

  it('puts the real error in the handoff reason, so it is visible without server logs', async () => {
    h.transcribeAudio.mockRejectedValue(new AiError('Gemini API error (429): quota exceeded'))
    const out = await transcribeInboundVoiceNote(fakeDb(), LISTEN)
    expect((out as { reason: string }).reason).toBe(
      'the voice note could not be turned into text (Gemini API error (429): quota exceeded).',
    )
  })
})

describe('toSpeakableText', () => {
  it('drops links, formatting marks and emoji but keeps the words and numbers', () => {
    expect(toSpeakableText(SPEAK.text)).toBe('السعر 300 ريال')
  })
})

describe('sendVoiceReply', () => {
  it('sends mono Ogg/Opus as a real voice note, flagged as the bot’s own', async () => {
    await sendVoiceReply(fakeDb(), SPEAK)

    expect(h.synthesizeSpeech).toHaveBeenCalledTimes(1)
    expect(h.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'eleven-test',
        voiceId: 'voice-1',
        text: 'السعر 300 ريال',
        outputFormat: 'opus-test',
      }),
    )
    expect(db.uploads).toHaveLength(1)
    expect(db.uploads[0].contentType).toBe('audio/ogg')
    expect(db.uploads[0].path).toMatch(/^account-acct-1\/\d+-ai-voice-[0-9a-f]{8}\.ogg$/)
    expect(h.engineSendMedia).toHaveBeenCalledWith({
      accountId: 'acct-1',
      userId: 'user-1',
      conversationId: 'conv-1',
      contactId: 'contact-1',
      kind: 'audio',
      link: `https://storage.test/chat-media/${db.uploads[0].path}`,
      voice: true,
      aiGenerated: true,
      previewText: SPEAK.text,
    })
  })

  it('falls back to MP3 as an ordinary audio message when the bytes are not Ogg/Opus', async () => {
    h.inspectOggOpus.mockReturnValue(NOT_OGG)
    await sendVoiceReply(fakeDb(), SPEAK)

    expect(h.synthesizeSpeech.mock.calls.map((c) => c[0].outputFormat)).toEqual([
      'opus-test',
      'mp3-test',
    ])
    expect(db.uploads[0].contentType).toBe('audio/mpeg')
    expect(db.uploads[0].path).toMatch(/\.mp3$/)
    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'audio', voice: false, aiGenerated: true }),
    )
  })

  it('sends stereo Ogg/Opus without the voice-note flag', async () => {
    h.inspectOggOpus.mockReturnValue({ ...OGG_MONO, channels: 2 })
    await sendVoiceReply(fakeDb(), SPEAK)
    expect(h.synthesizeSpeech).toHaveBeenCalledTimes(1)
    expect(h.engineSendMedia).toHaveBeenCalledWith(expect.objectContaining({ voice: false }))
  })

  it('does nothing when voice replies are switched off', async () => {
    h.loadVoiceConfig.mockResolvedValue(voiceConfig({ replyEnabled: false }))
    await sendVoiceReply(fakeDb(), SPEAK)
    expect(h.synthesizeSpeech).not.toHaveBeenCalled()
    expect(h.engineSendMedia).not.toHaveBeenCalled()
  })

  it('does nothing when the reply has nothing speakable in it', async () => {
    await sendVoiceReply(fakeDb(), { ...SPEAK, text: '🙂 https://example.com' })
    expect(h.synthesizeSpeech).not.toHaveBeenCalled()
  })

  it.each([
    ['ElevenLabs fails', () => h.synthesizeSpeech.mockRejectedValue(new AiError('quota'))],
    ['the audio cannot be stored', () => { db.uploadError = { message: 'bucket full' } }],
    ['WhatsApp rejects the audio', () => h.engineSendMedia.mockRejectedValue(new Error('131053'))],
    ['the settings cannot be read', () => h.loadVoiceConfig.mockRejectedValue(new Error('x'))],
  ])('never throws when %s (the text reply already went out)', async (_label, arrange) => {
    arrange()
    await expect(sendVoiceReply(fakeDb(), SPEAK)).resolves.toBeUndefined()
  })

  it('sends no audio when ElevenLabs fails', async () => {
    h.synthesizeSpeech.mockRejectedValue(new AiError('quota'))
    await sendVoiceReply(fakeDb(), SPEAK)
    expect(db.uploads).toEqual([])
    expect(h.engineSendMedia).not.toHaveBeenCalled()
  })
})
