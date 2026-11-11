import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadMedia, getMediaUrl } from '@/lib/whatsapp/meta-api'
import { engineSendMedia } from '@/lib/flows/meta-send'
import { loadVoiceConfig } from './config'
import { inspectOggOpus } from './ogg'
import { transcribeAudio } from './providers/gemini'
import {
  ELEVENLABS_MP3_FORMAT,
  ELEVENLABS_OPUS_FORMAT,
  synthesizeSpeech,
} from './providers/elevenlabs'
import { AiError } from './types'

// ============================================================
// Voice notes for the auto-reply bot.
//
//   listening — a customer's voice note → text (Gemini), saved on the
//               audio message's `content_text` so the inbox shows it
//               under the player and the bot reads it like typed text.
//   speaking  — the bot's text reply → a WhatsApp voice note
//               (ElevenLabs), sent in addition to the text.
//
// Both entry points are called from `dispatchInboundToAiReply` and
// NEVER throw: listening reports failure so the caller can hand the
// thread to a person; speaking just gives up (the text already went).
// ============================================================

/** Longest voice note the bot will listen to. Longer ones go to a person. */
export const MAX_VOICE_NOTE_SECONDS = 180
/** Size cap used only when the length can't be read (audio that isn't
 *  Ogg/Opus, e.g. a forwarded MP3) — roughly 3 minutes of MP3. */
export const MAX_VOICE_NOTE_BYTES = 3 * 1024 * 1024

const TRANSCRIBE_TIMEOUT_MS = 25_000
const SPEAK_TIMEOUT_MS = 20_000
const VOICE_BUCKET = 'chat-media'

/** What the webhook hands over for an inbound `audio` message. */
export interface InboundVoiceNote {
  /** Meta media id of the audio. */
  mediaId: string
  /** Meta message id (`wamid`) — how we find the row to save the text on. */
  whatsappMessageId: string
  /** The account's decrypted WhatsApp token, to download the audio. */
  accessToken: string
}

export type VoiceTranscription =
  /** Listening is switched off — behave exactly as before this feature. */
  | { status: 'off' }
  | { status: 'ok'; text: string }
  /** `reason` is a short sentence for the internal handoff note. */
  | { status: 'failed'; reason: string }

/**
 * Turn an inbound voice note into text and save it on the message.
 *
 * The caller runs this only after its own gates (test numbers, human
 * assigned, reply cap…), so no customer audio leaves the system for a
 * thread the bot wouldn't answer anyway.
 */
export async function transcribeInboundVoiceNote(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; voiceNote: InboundVoiceNote },
): Promise<VoiceTranscription> {
  const { accountId, conversationId, voiceNote } = args
  try {
    const voice = await loadVoiceConfig(db, accountId)
    if (!voice.transcriptionEnabled || !voice.geminiApiKey) return { status: 'off' }

    const { url, mimeType } = await getMediaUrl({
      mediaId: voiceNote.mediaId,
      accessToken: voiceNote.accessToken,
    })
    const { buffer } = await downloadMedia({
      downloadUrl: url,
      accessToken: voiceNote.accessToken,
    })

    const { durationSeconds } = inspectOggOpus(buffer)
    const tooLong =
      durationSeconds !== null
        ? durationSeconds > MAX_VOICE_NOTE_SECONDS
        : buffer.byteLength > MAX_VOICE_NOTE_BYTES
    if (tooLong) {
      return {
        status: 'failed',
        reason: `the voice note is longer than ${MAX_VOICE_NOTE_SECONDS / 60} minutes.`,
      }
    }

    const text = await transcribeAudio({
      apiKey: voice.geminiApiKey,
      audio: buffer,
      // Meta sends "audio/ogg; codecs=opus" — Gemini wants the bare type.
      mimeType: mimeType.split(';')[0].trim(),
      timeoutMs: TRANSCRIBE_TIMEOUT_MS,
    })
    if (!text.trim()) {
      return { status: 'failed', reason: 'no speech could be made out in the voice note.' }
    }

    // `content_type` stays 'audio' so the inbox still plays it; the text
    // rides in `content_text`, which audio messages otherwise leave empty.
    const { error } = await db
      .from('messages')
      .update({ content_text: text.trim() })
      .eq('conversation_id', conversationId)
      .eq('message_id', voiceNote.whatsappMessageId)
    if (error) throw new Error(`saving the transcript failed: ${error.message}`)

    return { status: 'ok', text: text.trim() }
  } catch (err) {
    console.error(
      `[ai voice] transcription failed on conversation ${conversationId}:`,
      err instanceof Error ? err.message : err,
    )
    const timedOut = err instanceof AiError && err.code === 'timeout'
    return {
      status: 'failed',
      reason: timedOut
        ? 'turning the voice note into text took too long.'
        : 'the voice note could not be turned into text.',
    }
  }
}

/**
 * Strip what reads badly aloud: links, WhatsApp formatting marks and
 * emoji. The customer still gets all of it in the text reply.
 */
export function toSpeakableText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[*_~`]/g, '')
    .replace(/\p{Extended_Pictographic}|️|‍/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Speak the bot's reply back as a WhatsApp voice note. Called AFTER the
 * text reply was sent, so any failure here costs only the audio.
 */
export async function sendVoiceReply(
  db: SupabaseClient,
  args: {
    accountId: string
    userId: string
    conversationId: string
    contactId: string
    text: string
  },
): Promise<void> {
  try {
    const voice = await loadVoiceConfig(db, args.accountId)
    if (!voice.replyEnabled || !voice.elevenLabsApiKey || !voice.elevenLabsVoiceId) return

    const spoken = toSpeakableText(args.text)
    if (!spoken) return

    const speak = (outputFormat: string) =>
      synthesizeSpeech({
        apiKey: voice.elevenLabsApiKey!,
        voiceId: voice.elevenLabsVoiceId!,
        text: spoken,
        outputFormat,
        timeoutMs: SPEAK_TIMEOUT_MS,
      })

    // WhatsApp only draws the voice-note bubble for mono Ogg/Opus. We ask
    // for Opus and check the bytes rather than trust the format name; if
    // it isn't an Ogg file we can't convert it here (no ffmpeg on the
    // host), so we fall back to MP3 sent as an ordinary audio message.
    let bytes = await speak(ELEVENLABS_OPUS_FORMAT)
    const ogg = inspectOggOpus(bytes)
    let file = { ext: 'ogg', contentType: 'audio/ogg', voice: ogg.channels === 1 }
    if (!ogg.isOggOpus) {
      console.warn(
        '[ai voice] ElevenLabs did not return an Ogg/Opus file — sending MP3 as a normal audio message instead.',
      )
      bytes = await speak(ELEVENLABS_MP3_FORMAT)
      file = { ext: 'mp3', contentType: 'audio/mpeg', voice: false }
    }

    // Same public bucket + path convention the inbox composer uses for
    // an agent's voice notes; Meta fetches the file from this link.
    const path = `account-${args.accountId}/${Date.now()}-ai-voice-${crypto.randomUUID().slice(0, 8)}.${file.ext}`
    const { error: uploadErr } = await db.storage
      .from(VOICE_BUCKET)
      .upload(path, bytes, { contentType: file.contentType })
    if (uploadErr) throw new Error(`storing the audio failed: ${uploadErr.message}`)
    const link = db.storage.from(VOICE_BUCKET).getPublicUrl(path).data.publicUrl

    await engineSendMedia({
      accountId: args.accountId,
      userId: args.userId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      kind: 'audio',
      link,
      voice: file.voice,
      // Must be flagged: an unflagged bot message would read as "someone
      // else is talking to this customer" and mute the bot for 24h.
      aiGenerated: true,
      // Keep the readable answer as the conversation-list preview.
      previewText: args.text,
    })
  } catch (err) {
    console.error(
      `[ai voice] voice reply failed on conversation ${args.conversationId} (the text reply was already sent):`,
      err instanceof Error ? err.message : err,
    )
  }
}
