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
