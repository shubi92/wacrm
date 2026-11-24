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
    replySpeed: 0.9,
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
})

describe('toSpeakableText', () => {
  it('drops links, formatting marks and emoji and spells the Arabic price out', () => {
    expect(toSpeakableText(SPEAK.text)).toBe('السعر ثلاثمئة ريال')
  })

  // Sentences from the tester's chat, then the edge cases.
  it.each([
    [
      'عدد المكيفات 4 (3 سبليت وواحد شباك)، والسعر 345 ريال شامل الضريبة.',
      'عدد المكيفات أربعة (ثلاثة سبليت وواحد شباك)، والسعر ثلاثمئة وخمسة وأربعين ريال شامل الضريبة.',
    ],
    [
      '1. *عادي*: 230 ريال شامل الضريبة.\n2. *بدون رائحة*: 345 ريال شامل الضريبة.\n\nالضمان شهرين.',
      'عادي: مئتين وثلاثين ريال شامل الضريبة. بدون رائحة: ثلاثمئة وخمسة وأربعين ريال شامل الضريبة. الضمان شهرين.',
    ],
    ['كل شهر إضافي 115 ريال شامل الضريبة.', 'كل شهر إضافي مئة وخمسة عشر ريال شامل الضريبة.'],
    [
      'تبي تكمل بالخيار العادي (230 ريال) ولا بدون رائحة (345 ريال)؟',
      'تبي تكمل بالخيار العادي (مئتين وثلاثين ريال) ولا بدون رائحة (ثلاثمئة وخمسة وأربعين ريال)؟',
    ],
    ['أرسل لي:\n1. اسمك\n2. الحي\n3. اليوم والوقت', 'أرسل لي: اسمك، الحي، اليوم والوقت'],
    ['المنتجات:\n١- سجاد\n٢) كنب', 'المنتجات: سجاد، كنب'],
    ['السعر 1,150 ريال', 'السعر ألف ومئة وخمسين ريال'],
    ['المساحة 6.5 متر', 'المساحة ستة ونص متر'],
    ['الوزن 2.25 كيلو', 'الوزن اثنين فاصلة اثنين خمسة كيلو'],
    ['يضاف +150 ريال', 'يضاف زائد مئة وخمسين ريال'],
    ['نوصل الساعة 7:30', 'نوصل الساعة سبعة ونص'],
    ['نوصل الساعة 12:00', 'نوصل الساعة اثنا عشر'],
    ['نوصل الساعة 9:15', 'نوصل الساعة تسعة وخمسة عشر دقيقة'],
    [
      'اتصل على 966501234567',
      'اتصل على تسعة ستة ستة خمسة صفر واحد اثنين ثلاثة أربعة خمسة ستة سبعة',
    ],
    [
      'اتصل على +966 50 123-4567',
      'اتصل على زائد تسعة ستة ستة خمسة صفر واحد اثنين ثلاثة أربعة خمسة ستة سبعة',
    ],
    ['السعر ٣٤٥ ريال', 'السعر ثلاثمئة وخمسة وأربعين ريال'],
    ['خصم 15% اليوم', 'خصم خمسة عشر بالمئة اليوم'],
    ['الشقة 120 م²', 'الشقة مئة وعشرين متر مربع'],
    ['السعر 2,000 أو 11,000 أو 100,000', 'السعر ألفين أو أحد عشر ألف أو مئة ألف'],
    ['من 3000 إلى 10000', 'من ثلاثة آلاف إلى عشرة آلاف'],
    // Ranges, square metres written with a plain 2, phone shapes.
    ['السعر من 1150-1500 ريال', 'السعر من ألف ومئة وخمسين إلى ألف وخمسمئة ريال'],
    ['السعر 300 - 450 ريال', 'السعر ثلاثمئة إلى أربعمئة وخمسين ريال'],
    ['المسافة 200–375 كم', 'المسافة مئتين إلى ثلاثمئة وخمسة وسبعين كم'],
    ['المسافة 376—700 كم', 'المسافة ثلاثمئة وستة وسبعين إلى سبعمئة كم'],
    ['المساحة 100-150 م²', 'المساحة مئة إلى مئة وخمسين متر مربع'],
    ['الشقة 30 م2', 'الشقة ثلاثين متر مربع'],
    ['الغرفة 45m2', 'الغرفة خمسة وأربعين متر مربع'],
    [
      'جوالي 0501234567',
      'جوالي صفر خمسة صفر واحد اثنين ثلاثة أربعة خمسة ستة سبعة',
    ],
    [
      'جوالي 050-123-4567',
      'جوالي صفر خمسة صفر واحد اثنين ثلاثة أربعة خمسة ستة سبعة',
    ],
    // Not converted with confidence → left exactly as written.
    ['الموعد 2026-11-25', 'الموعد 2026-11-25'],
    ['الموعد 25/11/2026', 'الموعد 25/11/2026'],
    ['رقم الطلب 12345678', 'رقم الطلب 12345678'],
    ['الرقم 0 والصفر في 05', 'الرقم صفر والصفر في 05'],
    ['سعر 1,500,000 ريال', 'سعر 1,500,000 ريال'],
    ['المقاس A4 و 5mm', 'المقاس A4 و 5mm'],
  ])('speaks %j as words', (written, spoken) => {
    expect(toSpeakableText(written)).toBe(spoken)
  })

  // Exact code points of the tester's spelling ("sure, right away").
  const MAN = '\u0623\u064E\u0628\u0634\u0650\u0631'
  const WOMAN = `${MAN}\u064A`
  it.each([
    ['أبشر', MAN],
    ['ابشر', MAN],
    ['أبشري', WOMAN],
    ['ابشري', WOMAN],
    ['أبشر، وصل طلبك', `${MAN}، وصل طلبك`],
    ['أبشر! ابشري؟ ابشر.', `${MAN}! ${WOMAN}؟ ${MAN}.`],
    ['طيب (*أبشر*)', `طيب (${MAN})`],
    ['👍أبشر❤️طال عمرك', `${MAN}طال عمرك`],
    ['❤️ابشري', WOMAN],
    ['تم\nابشري\nنخدمك', `تم ${WOMAN} نخدمك`],
    // With the number conversion in the same reply.
    ['أبشر، السعر 345 ريال شامل الضريبة.', `${MAN}، السعر ثلاثمئة وخمسة وأربعين ريال شامل الضريبة.`],
    ['1. ابشري\n2. السعر 230 ريال', `${WOMAN}، السعر مئتين وثلاثين ريال`],
    // Already marked, fully, partly or differently → exactly the tester's form.
    [MAN, MAN],
    [WOMAN, WOMAN],
    ['\u0627\u064E\u0628\u0652\u0634\u0650\u0631\u0652', MAN],
    ['\u0623\u0628\u0652\u0634\u0650\u0631\u0650\u064A،', `${WOMAN}،`],
  ])('gives the voice the marked form of %j', (written, spoken) => {
    expect(toSpeakableText(written)).toBe(spoken)
  })

  // Letters attached before or after: a different word.
  it.each([
    'أبشروا', 'نبشرك', 'بشرى', 'وأبشر', 'فابشري', 'أبشرك', 'أبشرين', 'تباشر',
    '\u0648\u064E\u0623\u0628\u0634\u0631', // marked prefix
    '\u0623\u0628\u0634\u0650\u0631\u064F\u0648\u0627', // marked ending
  ])('leaves the different word %j as written', (word) => {
    expect(toSpeakableText(`قلنا ${word} اليوم`)).toBe(`قلنا ${word} اليوم`)
  })

  it('leaves an English reply as it was', () => {
    const english = 'Two options:\n1. Standard: 230 SAR\n2. Odourless: 345 SAR, from 7:30 or call +966501234567.'
    expect(toSpeakableText(english)).toBe(
      'Two options: 1. Standard: 230 SAR 2. Odourless: 345 SAR, from 7:30 or call +966501234567.',
    )
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
        text: 'السعر ثلاثمئة ريال',
        speed: 0.9,
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

  it('speaks the marked word but keeps the written one unmarked', async () => {
    await sendVoiceReply(fakeDb(), { ...SPEAK, text: 'أبشر، السعر 300 ريال' })
    expect(h.synthesizeSpeech.mock.calls[0][0].text).toBe(
      '\u0623\u064E\u0628\u0634\u0650\u0631، السعر ثلاثمئة ريال',
    )
    expect(h.engineSendMedia).toHaveBeenCalledWith(
      expect.objectContaining({ previewText: 'أبشر، السعر 300 ريال' }),
    )
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

  it('speaks at the account’s own speed', async () => {
    h.loadVoiceConfig.mockResolvedValue(voiceConfig({ replySpeed: 1.08 }))
    await sendVoiceReply(fakeDb(), SPEAK)
    expect(h.synthesizeSpeech).toHaveBeenCalledTimes(1)
    expect(h.synthesizeSpeech).toHaveBeenCalledWith(
      expect.objectContaining({ speed: 1.08, outputFormat: 'opus-test' }),
    )
  })

  it('keeps that speed for the MP3 fallback too', async () => {
    h.loadVoiceConfig.mockResolvedValue(voiceConfig({ replySpeed: 1.08 }))
    h.inspectOggOpus.mockReturnValue(NOT_OGG)
    await sendVoiceReply(fakeDb(), SPEAK)
    expect(h.synthesizeSpeech.mock.calls.map((c) => [c[0].outputFormat, c[0].speed])).toEqual([
      ['opus-test', 1.08],
      ['mp3-test', 1.08],
    ])
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
