import { AiError } from '../types'
import { toNetworkError } from './shared'

// ============================================================
// ElevenLabs text-to-speech adapter (bring-your-own-key).
// Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert
// ============================================================

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1'
const VALIDATE_TIMEOUT_MS = 10_000

/**
 * Model + Opus output format used for WhatsApp voice replies.
 *
 * `eleven_multilingual_v2` is the endpoint's default model, the one the
 * models page lists with "Arabic (Saudi Arabia, UAE)", and the one it
 * recommends when numbers (prices, phone numbers) must be read properly.
 * It does NOT accept `language_code`, so we don't send one. 10,000
 * characters per request.
 *
 * 32 kbps Opus is ~4 KB per second, so a reply stays under WhatsApp's
 * 512 KB "play icon" limit for roughly two minutes of speech.
 */
export const ELEVENLABS_TTS_MODEL = 'eleven_multilingual_v2'
export const ELEVENLABS_OPUS_FORMAT = 'opus_48000_32'
/** Fallback only (sent as a plain audio message). No plan restriction —
 *  only mp3 192 kbps needs Creator or above. */
export const ELEVENLABS_MP3_FORMAT = 'mp3_44100_64'

/**
 * ElevenLabs errors are `{ detail: { code, status, message } }` (`status`
 * is the legacy name for `code`), `{ detail: "text" }`, or a 422
 * `{ detail: [{ msg }] }` — not the `{ error }` shape `providerHttpError`
 * reads, so the detail is pulled out here.
 */
async function elevenLabsHttpError(res: Response): Promise<AiError> {
  let code = ''
  let message = ''
  try {
    const body = (await res.json()) as { detail?: unknown }
    const detail = Array.isArray(body?.detail) ? body.detail[0] : body?.detail
    if (typeof detail === 'string') {
      message = detail
    } else if (detail && typeof detail === 'object') {
      const d = detail as Record<string, unknown>
      code = String(d.code ?? d.status ?? '')
      message = String(d.message ?? d.msg ?? '')
    }
  } catch {
    // Non-JSON error body — fall back to the status line.
  }

  const { status } = res
  const withDetail = (base: string) => (message ? `${base}: ${message}` : base)

  // 403 is not always the key: it is also "this voice needs a paid plan".
  if (status === 401 || code === 'insufficient_permissions' || code === 'missing_permissions') {
    return new AiError(withDetail('ElevenLabs rejected the API key'), {
      code: 'invalid_key',
      status: 401,
    })
  }
  if (status === 404 || code === 'voice_not_found' || code === 'invalid_voice_id') {
    return new AiError(withDetail('ElevenLabs could not find that voice'), {
      code: 'voice_not_found',
      status: 400,
    })
  }
  if (status === 429) {
    return new AiError(withDetail('ElevenLabs rate limit reached'), {
      code: 'rate_limited',
      status: 502,
    })
  }
  return new AiError(withDetail(`ElevenLabs API error (${status})`), {
    code: 'provider_error',
    status: 502,
  })
}

/** Text → speech bytes. Throws AiError on HTTP / network / timeout / empty body. */
export async function synthesizeSpeech(args: {
  apiKey: string
  voiceId: string
  text: string
  outputFormat: string
  timeoutMs: number
}): Promise<Uint8Array> {
  const { apiKey, voiceId, text, outputFormat, timeoutMs } = args
  const url =
    `${ELEVENLABS_BASE}/text-to-speech/${encodeURIComponent(voiceId)}` +
    `?output_format=${encodeURIComponent(outputFormat)}`

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, model_id: ELEVENLABS_TTS_MODEL }),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await elevenLabsHttpError(res)

  let bytes: Uint8Array
  try {
    // The timeout signal also covers the body download.
    bytes = new Uint8Array(await res.arrayBuffer())
  } catch (err) {
    throw toNetworkError(err)
  }
  if (bytes.byteLength === 0) {
    throw new AiError('ElevenLabs returned no audio.', { code: 'empty_response' })
  }
  return bytes
}

/**
 * Checks the key AND that the voice exists for it, via
 * `GET /v1/voices/{voice_id}`. Throws AiError (code 'invalid_key' for a
 * rejected key, 'voice_not_found' for a bad id). Spends no credits.
 * A restricted key needs the "Voices: Read" permission for this call
 * (and "Text to Speech" for `synthesizeSpeech`).
 */
export async function validateElevenLabsVoice(args: {
  apiKey: string
  voiceId: string
}): Promise<void> {
  let res: Response
  try {
    res = await fetch(`${ELEVENLABS_BASE}/voices/${encodeURIComponent(args.voiceId)}`, {
      headers: { 'xi-api-key': args.apiKey },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    })
  } catch (err) {
    throw toNetworkError(err)
  }
  if (!res.ok) throw await elevenLabsHttpError(res)
}
