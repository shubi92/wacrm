import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

// decrypt is identity in tests so we don't depend on real ciphertext.
// A value starting with "bad" simulates ciphertext that can't be decrypted.
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => {
    if (v.startsWith('bad')) throw new Error('bad ciphertext')
    return `plain:${v}`
  },
}))

import { loadAiConfig, loadVoiceConfig } from './config'

function dbReturning(
  row: Record<string, unknown> | null,
  error: { code: string; message: string } | null = null,
): SupabaseClient {
  const chain = {
    from: () => chain,
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: row, error }),
  }
  return chain as unknown as SupabaseClient
}

const ROW = {
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc-key',
  system_prompt: null,
  is_active: false,
  auto_reply_enabled: false,
  auto_reply_max_per_conversation: 3,
  embeddings_api_key: null,
}

describe('loadAiConfig requireActive', () => {
  it('returns null for an inactive config by default', async () => {
    expect(await loadAiConfig(dbReturning(ROW), 'acct')).toBeNull()
  })

  it('returns the config when requireActive is false (Playground path)', async () => {
    const config = await loadAiConfig(dbReturning(ROW), 'acct', {
      requireActive: false,
    })
    expect(config).not.toBeNull()
    expect(config!.provider).toBe('openai')
    expect(config!.apiKey).toBe('plain:enc-key')
  })

  it('returns null when there is no row', async () => {
    expect(
      await loadAiConfig(dbReturning(null), 'acct', { requireActive: false }),
    ).toBeNull()
  })
})

const VOICE_ROW = {
  voice_transcription_enabled: true,
  voice_reply_enabled: true,
  gemini_api_key: 'enc-gemini',
  elevenlabs_api_key: 'enc-eleven',
  elevenlabs_voice_id: 'voice-1',
}

const VOICE_OFF = {
  transcriptionEnabled: false,
  replyEnabled: false,
  geminiApiKey: null,
  elevenLabsApiKey: null,
  elevenLabsVoiceId: null,
  replySpeed: 0.9,
}

/**
 * The voice settings and the speaking speed are two reads of `ai_configs`
 * (the speed is migration 042's column, read on its own): this answers
 * each by the columns it asks for, and records what was asked.
 */
function voiceDb(
  voiceRow: Record<string, unknown> | null,
  speed: { row?: Record<string, unknown> | null; error?: { code: string; message: string } } = {},
) {
  const selects: string[] = []
  const db = {
    from: () => ({
      select: (columns: string) => {
        selects.push(columns)
        const isSpeed = columns === 'voice_reply_speed'
        const chain = {
          eq: () => chain,
          maybeSingle: () =>
            Promise.resolve(
              isSpeed
                ? { data: speed.error ? null : (speed.row ?? null), error: speed.error ?? null }
                : { data: voiceRow, error: null },
            ),
        }
        return chain
      },
    }),
  } as unknown as SupabaseClient
  return { db, selects }
}

describe('loadVoiceConfig', () => {
  it('is off when there is no row', async () => {
    expect(await loadVoiceConfig(dbReturning(null), 'acct')).toEqual(VOICE_OFF)
  })

  it('is off by default (columns at their defaults)', async () => {
    const row = {
      voice_transcription_enabled: false,
      voice_reply_enabled: false,
      gemini_api_key: null,
      elevenlabs_api_key: null,
      elevenlabs_voice_id: null,
    }
    expect(await loadVoiceConfig(dbReturning(row), 'acct')).toEqual(VOICE_OFF)
  })

  it('is on with both keys and a voice id', async () => {
    expect(await loadVoiceConfig(dbReturning(VOICE_ROW), 'acct')).toEqual({
      transcriptionEnabled: true,
      replyEnabled: true,
      geminiApiKey: 'plain:enc-gemini',
      elevenLabsApiKey: 'plain:enc-eleven',
      elevenLabsVoiceId: 'voice-1',
      // `dbReturning` hands the same row to the speed read: no speed in it.
      replySpeed: 0.9,
    })
  })

  it('returns everything off on a query error (migration 039 missing)', async () => {
    const db = dbReturning(null, { code: '42703', message: 'column does not exist' })
    expect(await loadVoiceConfig(db, 'acct')).toEqual(VOICE_OFF)
  })

  it('never throws when the client itself throws', async () => {
    const db = {
      from: () => {
        throw new Error('boom')
      },
    } as unknown as SupabaseClient
    expect(await loadVoiceConfig(db, 'acct')).toEqual(VOICE_OFF)
  })

  it('switches off (and replies with it) when the Gemini key cannot be decrypted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await loadVoiceConfig(
      dbReturning({ ...VOICE_ROW, gemini_api_key: 'bad-gemini' }),
      'acct',
    )
    expect(v.transcriptionEnabled).toBe(false)
    expect(v.replyEnabled).toBe(false)
    expect(v.geminiApiKey).toBeNull()
    // The breadcrumb names the account, never the key material.
    expect(spy).toHaveBeenCalled()
    expect(String(spy.mock.calls[0][0])).not.toContain('bad-gemini')
    spy.mockRestore()
  })

  it('keeps listening on but replies off when the ElevenLabs key cannot be decrypted', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const v = await loadVoiceConfig(
      dbReturning({ ...VOICE_ROW, elevenlabs_api_key: 'bad-eleven' }),
      'acct',
    )
    expect(v.transcriptionEnabled).toBe(true)
    expect(v.replyEnabled).toBe(false)
    expect(v.elevenLabsApiKey).toBeNull()
    spy.mockRestore()
  })

  it('replies need transcription on', async () => {
    const v = await loadVoiceConfig(
      dbReturning({ ...VOICE_ROW, voice_transcription_enabled: false }),
      'acct',
    )
    expect(v.transcriptionEnabled).toBe(false)
    expect(v.replyEnabled).toBe(false)
  })

  it('replies need a non-empty voice id', async () => {
    for (const voiceId of [null, '', '   ']) {
      const v = await loadVoiceConfig(
        dbReturning({ ...VOICE_ROW, elevenlabs_voice_id: voiceId }),
        'acct',
      )
      expect(v.transcriptionEnabled).toBe(true)
      expect(v.replyEnabled).toBe(false)
      expect(v.elevenLabsVoiceId).toBeNull()
    }
  })

  it('a switch without its key is off', async () => {
    const v = await loadVoiceConfig(
      dbReturning({ ...VOICE_ROW, gemini_api_key: null }),
      'acct',
    )
    expect(v).toMatchObject({ transcriptionEnabled: false, replyEnabled: false })
  })
})

describe('loadVoiceConfig — the speaking speed', () => {
  it('is the account’s stored speed when voice replies are on', async () => {
    const { db, selects } = voiceDb(VOICE_ROW, { row: { voice_reply_speed: 1.08 } })
    const v = await loadVoiceConfig(db, 'acct')
    expect(v).toMatchObject({ replyEnabled: true, replySpeed: 1.08 })
    // Read on its own, after the settings that say replies are on.
    expect(selects).toHaveLength(2)
    expect(selects[1]).toBe('voice_reply_speed')
    expect(selects[0]).not.toContain('voice_reply_speed')
  })

  it('reads a numeric the database hands back as text', async () => {
    const { db } = voiceDb(VOICE_ROW, { row: { voice_reply_speed: '1.08' } })
    expect((await loadVoiceConfig(db, 'acct')).replySpeed).toBe(1.08)
  })

  it('keeps voice replies ON, at 0.9, on a database without migration 042', async () => {
    const { db } = voiceDb(VOICE_ROW, {
      error: { code: '42703', message: 'column ai_configs.voice_reply_speed does not exist' },
    })
    expect(await loadVoiceConfig(db, 'acct')).toEqual({
      transcriptionEnabled: true,
      replyEnabled: true,
      geminiApiKey: 'plain:enc-gemini',
      elevenLabsApiKey: 'plain:enc-eleven',
      elevenLabsVoiceId: 'voice-1',
      replySpeed: 0.9,
    })
  })

  it.each([
    [5, 1.2],
    [0.1, 0.7],
    [1.0849, 1.08],
  ])('brings a stored %s inside the range, as %s', async (stored, spoken) => {
    const { db } = voiceDb(VOICE_ROW, { row: { voice_reply_speed: stored } })
    expect((await loadVoiceConfig(db, 'acct')).replySpeed).toBe(spoken)
  })

  it.each([
    ['there is no row for the speed', null],
    ['the speed is null', { voice_reply_speed: null }],
    ['the speed is not a number', { voice_reply_speed: 'fast' }],
  ])('is 0.9 when %s', async (_name, row) => {
    const { db } = voiceDb(VOICE_ROW, { row })
    expect(await loadVoiceConfig(db, 'acct')).toMatchObject({ replyEnabled: true, replySpeed: 0.9 })
  })

  it.each([
    ['voice replies are switched off', { ...VOICE_ROW, voice_reply_enabled: false }],
    ['listening is switched off', { ...VOICE_ROW, voice_transcription_enabled: false }],
    ['there is no voice id', { ...VOICE_ROW, elevenlabs_voice_id: null }],
    ['there are no voice settings at all', null],
  ])('does not read the speed when %s: nothing will be spoken', async (_name, voiceRow) => {
    const { db, selects } = voiceDb(voiceRow, { row: { voice_reply_speed: 1.2 } })
    const v = await loadVoiceConfig(db, 'acct')
    expect(v).toMatchObject({ replyEnabled: false, replySpeed: 0.9 })
    expect(selects).not.toContain('voice_reply_speed')
  })
})
