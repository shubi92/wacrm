import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { AiConfig, VoiceConfig } from './types'

interface AiConfigRow {
  provider: 'openai' | 'anthropic'
  model: string
  api_key: string
  system_prompt: string | null
  is_active: boolean
  auto_reply_enabled: boolean
  auto_reply_max_per_conversation: number
  handoff_agent_id: string | null
  embeddings_api_key: string | null
}

const CONFIG_COLUMNS =
  'provider, model, api_key, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, embeddings_api_key'

/**
 * Load and decrypt the account's AI config for *use* (draft or
 * auto-reply). Returns `null` when there's no row or the master switch
 * (`is_active`) is off — both mean "AI is not available", which callers
 * treat identically. Throws only if the stored key can't be decrypted
 * (mismatched `ENCRYPTION_KEY`), so that distinct failure surfaces
 * rather than looking like "not configured".
 *
 * Works with any client: pass the RLS-scoped SSR client from a
 * dashboard route, or the service-role admin client from the webhook.
 */
export async function loadAiConfig(
  db: SupabaseClient,
  accountId: string,
  opts: { requireActive?: boolean } = {},
): Promise<AiConfig | null> {
  const { requireActive = true } = opts
  const { data, error } = await db
    .from('ai_configs')
    .select(CONFIG_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  const row = data as AiConfigRow
  // The Playground passes requireActive:false so an admin can test the
  // agent before flipping the master switch on.
  if (requireActive && !row.is_active) return null
  // Defensive: the column is NOT NULL, but a partial write / manual DB
  // edit could leave it empty. Treat a missing key as "not configured"
  // rather than letting decrypt() throw on null.
  if (!row.api_key) return null

  // The embeddings key is optional and independent of the chat key —
  // a corrupt/undecryptable one should downgrade to lexical KB, not
  // take down draft/auto-reply, so decrypt failures are swallowed here.
  let embeddingsApiKey: string | null = null
  if (row.embeddings_api_key) {
    try {
      embeddingsApiKey = decrypt(row.embeddings_api_key)
    } catch {
      // Not silent — a rotated/mismatched ENCRYPTION_KEY here means
      // semantic search quietly stops working, so leave a breadcrumb.
      console.error(
        `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; semantic search is disabled until it is re-entered.`,
      )
      embeddingsApiKey = null
    }
  }

  return {
    provider: row.provider,
    model: row.model,
    apiKey: decrypt(row.api_key),
    systemPrompt: row.system_prompt,
    isActive: row.is_active,
    autoReplyEnabled: row.auto_reply_enabled,
    autoReplyMaxPerConversation: row.auto_reply_max_per_conversation,
    handoffAgentId: row.handoff_agent_id,
    embeddingsApiKey,
  }
}

/**
 * Load + decrypt just the embeddings key, independent of `is_active`.
 * Used by the knowledge-base ingest routes so the KB gets embedded (and
 * semantic search works) whenever an embeddings key is present, even if
 * the assistant's master switch is currently off.
 *
 * Returns `{ key, corrupt }`: `key` is null when there's no key OR it
 * can't be decrypted; `corrupt` distinguishes those cases so callers can
 * warn ("a key is set but unusable") rather than silently indexing
 * lexical-only and reporting success.
 */
export async function loadEmbeddingsKey(
  db: SupabaseClient,
  accountId: string,
): Promise<{ key: string | null; corrupt: boolean }> {
  const { data, error } = await db
    .from('ai_configs')
    .select('embeddings_api_key')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error || !data?.embeddings_api_key) return { key: null, corrupt: false }
  try {
    return { key: decrypt(data.embeddings_api_key), corrupt: false }
  } catch {
    console.error(
      `[ai config] embeddings key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY.`,
    )
    return { key: null, corrupt: true }
  }
}

const VOICE_OFF: VoiceConfig = {
  transcriptionEnabled: false,
  replyEnabled: false,
  geminiApiKey: null,
  elevenLabsApiKey: null,
  elevenLabsVoiceId: null,
}

/**
 * Read separately from loadAiConfig so the rest of AI keeps working on a
 * database that hasn't run migration 039. NEVER throws: any read or decrypt
 * failure returns the feature switched off (and logs a breadcrumb without the key).
 */
export async function loadVoiceConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<VoiceConfig> {
  try {
    const { data, error } = await db
      .from('ai_configs')
      .select(
        'voice_transcription_enabled, voice_reply_enabled, gemini_api_key, elevenlabs_api_key, elevenlabs_voice_id',
      )
      .eq('account_id', accountId)
      .maybeSingle()
    // An error here is usually "column does not exist" (migration 039 not
    // run) — the feature is simply off, so no log noise per inbound message.
    if (error || !data) return { ...VOICE_OFF }

    const decryptOrNull = (label: string, value: unknown): string | null => {
      if (typeof value !== 'string' || !value) return null
      try {
        return decrypt(value)
      } catch {
        console.error(
          `[ai config] ${label} key for account ${accountId} could not be decrypted — check ENCRYPTION_KEY; voice notes stay off until it is re-entered.`,
        )
        return null
      }
    }

    const geminiApiKey = decryptOrNull('Gemini', data.gemini_api_key)
    const elevenLabsApiKey = decryptOrNull('ElevenLabs', data.elevenlabs_api_key)
    const elevenLabsVoiceId =
      typeof data.elevenlabs_voice_id === 'string' && data.elevenlabs_voice_id.trim()
        ? data.elevenlabs_voice_id.trim()
        : null

    // A switch only counts as on when what it needs is actually usable.
    const transcriptionEnabled =
      data.voice_transcription_enabled === true && !!geminiApiKey
    const replyEnabled =
      data.voice_reply_enabled === true &&
      transcriptionEnabled &&
      !!elevenLabsApiKey &&
      !!elevenLabsVoiceId

    return {
      transcriptionEnabled,
      replyEnabled,
      geminiApiKey,
      elevenLabsApiKey,
      elevenLabsVoiceId,
    }
  } catch (err) {
    console.error(
      `[ai config] voice settings for account ${accountId} could not be read:`,
      err instanceof Error ? err.message : err,
    )
    return { ...VOICE_OFF }
  }
}
