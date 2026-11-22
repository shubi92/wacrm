// How fast the bot speaks in a voice reply: a per-account setting
// (`ai_configs.voice_reply_speed`, migration 042) sent to ElevenLabs as
// `voice_settings.speed`. No server-only imports: the settings page uses
// the same numbers.

/** ElevenLabs' documented range: "to a minimum of 0.7 … to a maximum of
 *  1.2". 1.0 is the voice's own pace. */
export const VOICE_SPEED_MIN = 0.7
export const VOICE_SPEED_MAX = 1.2
/** What every account spoke at before this was a setting. */
export const VOICE_SPEED_DEFAULT = 0.9

/**
 * A speed someone sent us, brought inside the range and rounded to two
 * decimals. Null when it is not a number at all — the caller decides
 * whether that is an error (a save) or the default (a read).
 */
export function toVoiceSpeed(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const inRange = Math.min(VOICE_SPEED_MAX, Math.max(VOICE_SPEED_MIN, value))
  return Math.round(inRange * 100) / 100
}

/** The stored speed (the database may hand a numeric back as text), or
 *  the default when there is none or it can't be read. */
export function storedVoiceSpeed(stored: unknown): number {
  const n = typeof stored === 'string' && stored.trim() ? Number(stored) : stored
  return toVoiceSpeed(n) ?? VOICE_SPEED_DEFAULT
}
