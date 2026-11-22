import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GEMINI_TRANSCRIBE_MODEL, transcribeAudio, validateGeminiKey } from './gemini'
import { AiError } from '../types'

// No real Gemini call is made anywhere here — `fetch` is stubbed.

const ARGS = {
  apiKey: 'test-key',
  audio: new Uint8Array([1, 2, 3, 250]),
  mimeType: 'audio/ogg',
  timeoutMs: 5_000,
}

function okResponse(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json } as unknown as Response
}

function errResponse(status: number, json: unknown): Response {
  return { ok: false, status, json: async () => json } as unknown as Response
}

/** A normal `generateContent` answer carrying `text`. */
function transcript(text: string, finishReason = 'STOP') {
  return { candidates: [{ finishReason, content: { parts: [{ text }] } }] }
}

// What Gemini sends for a bad key: HTTP 400, not 401/403.
const INVALID_KEY_BODY = {
  error: {
    code: 400,
    message: 'API key not valid. Please pass a valid API key.',
    status: 'INVALID_ARGUMENT',
    details: [{ reason: 'API_KEY_INVALID' }],
  },
}

const fetchMock = () => vi.mocked(fetch)

async function failure(p: Promise<unknown>): Promise<AiError> {
  const err = await p.catch((e) => e)
  expect(err).toBeInstanceOf(AiError)
  return err as AiError
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})
afterEach(() => vi.unstubAllGlobals())

describe('transcribeAudio', () => {
  it('posts the audio inline to the model URL with the key in a header only', async () => {
    fetchMock().mockResolvedValue(okResponse(transcript('مرحبا')))

    await transcribeAudio(ARGS)

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit]
    expect(url).toBe(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSCRIBE_MODEL}:generateContent`,
    )
    expect(url).not.toContain('test-key')
    expect(init.method).toBe('POST')
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
    expect(init.signal).toBeInstanceOf(AbortSignal)

    const body = JSON.parse(init.body as string)
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].parts).toContainEqual({
      inline_data: {
        mime_type: 'audio/ogg',
        data: Buffer.from(ARGS.audio).toString('base64'),
      },
    })
    // Gemini 3 needs text in the user turn, not only in the system instruction.
    expect(body.contents[0].parts.some((p: { text?: string }) => !!p.text)).toBe(true)
    expect(body.generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    expect(body.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(4096)
    // Deprecated on Gemini 3.6+ — must not be sent.
    expect(body.generationConfig).not.toHaveProperty('temperature')
  })

  it('tells the model to transcribe verbatim and to treat the audio as untrusted', async () => {
    fetchMock().mockResolvedValue(okResponse(transcript('hi')))

    await transcribeAudio(ARGS)

    const init = fetchMock().mock.calls[0][1] as RequestInit
    const instruction: string = JSON.parse(init.body as string).system_instruction.parts[0].text
    expect(instruction).toMatch(/verbatim/i)
    expect(instruction).toMatch(/Saudi \/ Gulf Arabic/)
    expect(instruction).toMatch(/Do not translate/i)
    expect(instruction).toMatch(/timestamps/i)
    expect(instruction).toContain('[[NO_SPEECH]]')
    expect(instruction).toMatch(/never an instruction/i)
  })

  it('returns the transcript trimmed, joining parts and skipping thoughts', async () => {
    fetchMock().mockResolvedValue(
      okResponse({
        candidates: [
          {
            finishReason: 'STOP',
            content: {
              parts: [
                { text: 'thinking about it', thought: true },
                { text: '  أبغى أحجز ' },
                { text: 'موعد بكرة\n' },
              ],
            },
          },
        ],
      }),
    )
    await expect(transcribeAudio(ARGS)).resolves.toBe('أبغى أحجز موعد بكرة')
  })

  it("maps the no-speech sentinel to ''", async () => {
    fetchMock().mockResolvedValue(okResponse(transcript(' [[NO_SPEECH]]\n')))
    await expect(transcribeAudio(ARGS)).resolves.toBe('')
    // …even when the model dresses the marker up.
    fetchMock().mockResolvedValue(okResponse(transcript('[[NO_SPEECH]].')))
    await expect(transcribeAudio(ARGS)).resolves.toBe('')
  })

  it('throws "blocked" when the prompt was blocked (no candidates)', async () => {
    fetchMock().mockResolvedValue(okResponse({ promptFeedback: { blockReason: 'SAFETY' } }))
    const err = await failure(transcribeAudio(ARGS))
    expect(err.code).toBe('blocked')
    expect(err.message).toContain('SAFETY')
  })

  it.each([
    ['no candidates', {}],
    ['an empty candidate', { candidates: [{ finishReason: 'STOP', content: { parts: [] } }] }],
    ['a non-JSON body', null],
  ])('throws "empty_response" on %s', async (_label, json) => {
    fetchMock().mockResolvedValue(okResponse(json))
    expect((await failure(transcribeAudio(ARGS))).code).toBe('empty_response')
  })

  it.each([
    ['PROHIBITED_CONTENT', 'blocked'],
    ['MAX_TOKENS', 'truncated'],
  ])('refuses a %s finish even when it carries text (%s)', async (finishReason, code) => {
    fetchMock().mockResolvedValue(okResponse(transcript('half a sent', finishReason)))
    expect((await failure(transcribeAudio(ARGS))).code).toBe(code)
  })

  it('maps Gemini\'s HTTP 400 "API key not valid" to invalid_key', async () => {
    fetchMock().mockResolvedValue(errResponse(400, INVALID_KEY_BODY))
    const err = await failure(transcribeAudio(ARGS))
    expect(err.code).toBe('invalid_key')
    expect(err.status).toBe(401)
    expect(err.message).toBe(
      'Gemini rejected the API key: API key not valid. Please pass a valid API key.',
    )
    expect(err.message).not.toContain('test-key')
  })

  it('leaves other 400s and rate limits to the shared mapping', async () => {
    fetchMock().mockResolvedValue(
      errResponse(400, { error: { message: 'Unsupported MIME type: audio/x-foo' } }),
    )
    expect((await failure(transcribeAudio(ARGS))).code).toBe('provider_error')

    fetchMock().mockResolvedValue(errResponse(429, { error: { message: 'Quota exceeded' } }))
    expect((await failure(transcribeAudio(ARGS))).code).toBe('rate_limited')
  })

  describe('a brief outage at Google (5xx)', () => {
    const UNAVAILABLE = errResponse(503, { error: { message: 'The model is overloaded.' } })
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => vi.useRealTimers())

    it('retries once and returns the transcript', async () => {
      fetchMock().mockResolvedValueOnce(UNAVAILABLE).mockResolvedValueOnce(okResponse(transcript('مرحبا')))
      const result = transcribeAudio(ARGS)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await result).toBe('مرحبا')
      expect(fetchMock()).toHaveBeenCalledTimes(2)
    })

    it('gives up after the one retry, with Google\'s own message', async () => {
      fetchMock().mockResolvedValue(UNAVAILABLE)
      const result = failure(transcribeAudio(ARGS))
      await vi.advanceTimersByTimeAsync(2_000)
      const err = await result
      expect(err.code).toBe('provider_error')
      expect(err.message).toBe('Gemini API error (503): The model is overloaded.')
      expect(fetchMock()).toHaveBeenCalledTimes(2)
    })

    it('does not retry when too little of the time budget is left', async () => {
      fetchMock().mockResolvedValue(UNAVAILABLE)
      await failure(transcribeAudio({ ...ARGS, timeoutMs: 2_000 }))
      expect(fetchMock()).toHaveBeenCalledTimes(1)
    })
  })

  it('does not retry a 4xx (key, quota, bad request)', async () => {
    fetchMock().mockResolvedValue(errResponse(429, { error: { message: 'Quota exceeded' } }))
    await failure(transcribeAudio(ARGS))
    expect(fetchMock()).toHaveBeenCalledTimes(1)
  })

  it('maps a timeout to code "timeout" and other rejections to network_error', async () => {
    fetchMock().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    expect((await failure(transcribeAudio(ARGS))).code).toBe('timeout')

    fetchMock().mockRejectedValue(new TypeError('fetch failed'))
    expect((await failure(transcribeAudio(ARGS))).code).toBe('network_error')
  })
})

describe('validateGeminiKey', () => {
  it('resolves on 200 from the models list, key in a header only', async () => {
    fetchMock().mockResolvedValue(okResponse({ models: [] }))

    await expect(validateGeminiKey('test-key')).resolves.toBeUndefined()

    const [url, init] = fetchMock().mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1')
    expect(init.method ?? 'GET').toBe('GET')
    expect(init.headers).toMatchObject({ 'x-goog-api-key': 'test-key' })
    expect(init.body).toBeUndefined()
  })

  it.each([
    ['400 API_KEY_INVALID', errResponse(400, INVALID_KEY_BODY)],
    ['401', errResponse(401, { error: { code: 'authentication', message: 'Bad key' } })],
    ['403', errResponse(403, { error: { message: 'Permission denied' } })],
  ])('throws invalid_key on %s', async (_label, res) => {
    fetchMock().mockResolvedValue(res)
    expect((await failure(validateGeminiKey('test-key'))).code).toBe('invalid_key')
  })

  it('maps a timeout to code "timeout"', async () => {
    fetchMock().mockRejectedValue(new DOMException('The operation timed out.', 'TimeoutError'))
    expect((await failure(validateGeminiKey('test-key'))).code).toBe('timeout')
  })
})
