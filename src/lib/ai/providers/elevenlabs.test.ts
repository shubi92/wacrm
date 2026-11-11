import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ELEVENLABS_OPUS_FORMAT,
  ELEVENLABS_TTS_MODEL,
  synthesizeSpeech,
  validateElevenLabsVoice,
} from './elevenlabs'
import { AiError } from '../types'

const ARGS = {
  apiKey: 'fake-xi-key',
  voiceId: 'voice/with space',
  text: 'مرحبا، كيف أقدر أساعدك؟',
  outputFormat: ELEVENLABS_OPUS_FORMAT,
  timeoutMs: 5_000,
}

function audioResponse(bytes: number[]): Response {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new Uint8Array(bytes).buffer,
  } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

const fetchMock = () => vi.mocked(fetch)

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('synthesizeSpeech', () => {
  it('posts text + model to the encoded voice URL with the key in xi-api-key', async () => {
    fetchMock().mockResolvedValue(audioResponse([1, 2, 3]))

    const bytes = await synthesizeSpeech(ARGS)

    expect(Array.from(bytes)).toEqual([1, 2, 3])
    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      'https://api.elevenlabs.io/v1/text-to-speech/voice%2Fwith%20space?output_format=opus_48000_32',
    )
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'xi-api-key': 'fake-xi-key' })
    expect(JSON.parse(init.body as string)).toEqual({
      text: ARGS.text,
      model_id: ELEVENLABS_TTS_MODEL,
    })
    expect(url).not.toContain('fake-xi-key')
  })

  it('throws AiError on an empty body', async () => {
    fetchMock().mockResolvedValue(audioResponse([]))
    const err = await synthesizeSpeech(ARGS).catch((e) => e)
    expect(err).toBeInstanceOf(AiError)
    expect(err).toMatchObject({ code: 'empty_response' })
  })

  it('maps a 401 to invalid_key and keeps the provider message', async () => {
    fetchMock().mockResolvedValue(
      errResponse(401, { detail: { status: 'invalid_api_key', message: 'Invalid API key' } }),
    )
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({
      code: 'invalid_key',
      status: 401,
      message: expect.stringContaining('Invalid API key'),
    })
  })

  it('treats a missing-permission key as invalid_key, other 403s as provider_error', async () => {
    fetchMock().mockResolvedValueOnce(
      errResponse(403, { detail: { code: 'insufficient_permissions', message: 'no tts' } }),
    )
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({ code: 'invalid_key' })

    fetchMock().mockResolvedValueOnce(
      errResponse(403, { detail: { code: 'subscription_required', message: 'paid only' } }),
    )
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('paid only'),
    })
  })

  it('survives string, list and non-JSON error bodies', async () => {
    fetchMock().mockResolvedValueOnce(errResponse(500, { detail: 'boom' }))
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({
      code: 'provider_error',
      message: expect.stringContaining('boom'),
    })

    fetchMock().mockResolvedValueOnce(
      errResponse(422, { detail: [{ loc: ['body', 'text'], msg: 'field required', type: 'missing' }] }),
    )
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({
      message: expect.stringContaining('field required'),
    })

    fetchMock().mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: async () => {
        throw new Error('not json')
      },
    } as unknown as Response)
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({ code: 'provider_error' })
  })

  it('maps a timeout to code timeout', async () => {
    fetchMock().mockRejectedValue(new DOMException('timed out', 'TimeoutError'))
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({ code: 'timeout' })
  })

  it('maps a timeout while downloading the audio to code timeout', async () => {
    fetchMock().mockResolvedValue({
      ok: true,
      status: 200,
      arrayBuffer: async () => {
        throw new DOMException('timed out', 'TimeoutError')
      },
    } as unknown as Response)
    await expect(synthesizeSpeech(ARGS)).rejects.toMatchObject({ code: 'timeout' })
  })
})

describe('validateElevenLabsVoice', () => {
  const V = { apiKey: 'fake-xi-key', voiceId: 'abc 123' }

  it('resolves when the voice exists, with a GET that carries the key', async () => {
    fetchMock().mockResolvedValue({ ok: true, status: 200 } as Response)

    await expect(validateElevenLabsVoice(V)).resolves.toBeUndefined()

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.elevenlabs.io/v1/voices/abc%20123')
    expect(init.method).toBeUndefined() // GET — spends no credits
    expect(init.headers).toMatchObject({ 'xi-api-key': 'fake-xi-key' })
  })

  it('throws invalid_key for a rejected key', async () => {
    fetchMock().mockResolvedValue(
      errResponse(401, { detail: { code: 'invalid_api_key', message: 'Invalid API key' } }),
    )
    await expect(validateElevenLabsVoice(V)).rejects.toMatchObject({ code: 'invalid_key' })
  })

  it('throws voice_not_found for an unknown voice (404, or the legacy 400 shape)', async () => {
    fetchMock().mockResolvedValueOnce(
      errResponse(404, { detail: { code: 'voice_not_found', message: 'Voice not found' } }),
    )
    await expect(validateElevenLabsVoice(V)).rejects.toMatchObject({ code: 'voice_not_found' })

    fetchMock().mockResolvedValueOnce(
      errResponse(400, { detail: { status: 'voice_not_found', message: 'nope' } }),
    )
    await expect(validateElevenLabsVoice(V)).rejects.toMatchObject({ code: 'voice_not_found' })
  })
})
