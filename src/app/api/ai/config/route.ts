import { NextResponse } from 'next/server'
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'
import { validateAiCredentials } from '@/lib/ai/validate'
import { embedTexts } from '@/lib/ai/embeddings'
import { AiError, type AiProvider } from '@/lib/ai/types'
import { parseTestNumbers } from '@/lib/ai/test-numbers'
import { validateGeminiKey } from '@/lib/ai/providers/gemini'
import { validateElevenLabsVoice } from '@/lib/ai/providers/elevenlabs'

const MIGRATION_038_MISSING =
  'Test numbers need database migration 038 (ai_configs.auto_reply_test_numbers). Nothing was saved.'
const MIGRATION_039_MISSING =
  'Voice notes need database migration 039 (ai_configs voice columns). Nothing was saved.'

const VOICE_COLUMNS =
  'voice_transcription_enabled, voice_reply_enabled, gemini_api_key, elevenlabs_api_key, elevenlabs_voice_id'
const VOICE_FIELDS = VOICE_COLUMNS.split(', ')

// "<provider's message>. Nothing was saved." without doubling the full stop.
function notSaved(prefix: string, message: string) {
  return `${prefix}${message.replace(/[.\s]+$/, '')}. Nothing was saved.`
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount()

    const { data, error } = await supabase
      .from('ai_configs')
      // `api_key` is selected only to derive `has_key` — it is stripped
      // out below and never returned to the client.
      .select(
        'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key',
      )
      .eq('account_id', accountId)
      .maybeSingle()

    if (error) {
      console.error('[ai/config GET] fetch error:', error)
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 },
      )
    }

    // Read on its own so a database without migration 038 still loads the
    // rest of the config; `null` tells the form the field is unavailable.
    // Probed even when there's no row yet, so a brand-new account can set
    // test numbers before its first activation.
    const { data: tn, error: tnErr } = await supabase
      .from('ai_configs')
      .select('auto_reply_test_numbers')
      .eq('account_id', accountId)
      .maybeSingle()
    const testNumbers = tnErr
      ? null
      : ((tn?.auto_reply_test_numbers as string[] | null) ?? [])

    // Same idea for voice notes (migration 039): read alone, and
    // `voice_available: false` hides the card when the columns are missing.
    // The two keys are read only to derive the has_* flags.
    const { data: vc, error: vcErr } = await supabase
      .from('ai_configs')
      .select(VOICE_COLUMNS)
      .eq('account_id', accountId)
      .maybeSingle()
    const voice = {
      voice_available: !vcErr,
      voice_transcription_enabled: vc?.voice_transcription_enabled === true,
      voice_reply_enabled: vc?.voice_reply_enabled === true,
      elevenlabs_voice_id: (vc?.elevenlabs_voice_id as string | null) ?? null,
      has_gemini_key: !!vc?.gemini_api_key,
      has_elevenlabs_key: !!vc?.elevenlabs_api_key,
    }

    if (!data) {
      return NextResponse.json({
        configured: false,
        auto_reply_test_numbers: testNumbers,
        ...voice,
      })
    }
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    const { api_key, embeddings_api_key, ...safe } = data
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      ...safe,
      auto_reply_test_numbers: testNumbers,
      ...voice,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin')

    const limit = checkRateLimit(`ai-config:${userId}`, RATE_LIMITS.adminAction)
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    if (!body || typeof body !== 'object') return bad('Invalid request body')

    const provider = body.provider as AiProvider
    if (provider !== 'openai' && provider !== 'anthropic') {
      return bad('provider must be "openai" or "anthropic"')
    }
    const model = typeof body.model === 'string' ? body.model.trim() : ''
    if (!model) return bad('model is required')

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null
    const isActive = body.is_active === true
    const autoReplyEnabled = body.auto_reply_enabled === true

    // Validate test numbers BEFORE anything is written: an entry that
    // can't be read must never turn into an empty list ("reply to everyone").
    const testNumbersProvided = 'auto_reply_test_numbers' in body
    let testNumbers: string[] = []
    if (testNumbersProvided) {
      const parsed = parseTestNumbers(body.auto_reply_test_numbers)
      if (!parsed.ok) {
        return bad(
          `These test numbers aren't valid phone numbers: ${parsed.invalid.slice(0, 5).join(', ')}. Nothing was saved.`,
        )
      }
      testNumbers = parsed.numbers
    }

    let maxPer = Number(body.auto_reply_max_per_conversation)
    if (!Number.isFinite(maxPer)) maxPer = 3
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)))

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string' ? body.handoff_agent_id.trim() : ''
    const handoffProvided = 'handoff_agent_id' in body
    let handoffAgentId: string | null = null
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle()
      if (!member) return bad('handoff_agent_id must be a member of this account')
      handoffAgentId = rawHandoff
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : ''
    const clearEmbeddingsKey = body.embeddings_api_key === null

    // Voice notes (migration 039). Untouched unless the form sent a voice
    // field, so an older form build — or a database without 039 — still
    // saves. Keys follow the embeddings-key rule: text sets, null clears,
    // absent leaves unchanged. Everything is checked BEFORE any write.
    const voiceProvided = VOICE_FIELDS.some((f) => f in body)
    const rawGeminiKey =
      typeof body.gemini_api_key === 'string' ? body.gemini_api_key.trim() : ''
    const rawElevenLabsKey =
      typeof body.elevenlabs_api_key === 'string'
        ? body.elevenlabs_api_key.trim()
        : ''
    const voiceWrite: Record<string, unknown> = {}
    // Set when a new key / changed voice still has to be checked with ElevenLabs.
    let elevenLabsCheck: { apiKey: string; voiceId: string } | null = null
    if (voiceProvided) {
      const { data: storedVoice, error: voiceErr } = await supabase
        .from('ai_configs')
        .select(VOICE_COLUMNS)
        .eq('account_id', accountId)
        .maybeSingle()
      if (voiceErr) {
        if (voiceErr.code === '42703') return bad(MIGRATION_039_MISSING)
        console.error('[ai/config POST] voice read error:', voiceErr)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }

      const transcriptionOn =
        'voice_transcription_enabled' in body
          ? body.voice_transcription_enabled === true
          : storedVoice?.voice_transcription_enabled === true
      const replyOn =
        'voice_reply_enabled' in body
          ? body.voice_reply_enabled === true
          : storedVoice?.voice_reply_enabled === true
      const storedVoiceId =
        typeof storedVoice?.elevenlabs_voice_id === 'string'
          ? storedVoice.elevenlabs_voice_id
          : null
      const voiceIdProvided = 'elevenlabs_voice_id' in body
      const voiceId = voiceIdProvided
        ? typeof body.elevenlabs_voice_id === 'string'
          ? body.elevenlabs_voice_id.trim() || null
          : null
        : storedVoiceId
      const clearGeminiKey = body.gemini_api_key === null
      const clearElevenLabsKey = body.elevenlabs_api_key === null
      const hasGeminiKey =
        !!rawGeminiKey || (!clearGeminiKey && !!storedVoice?.gemini_api_key)
      const storedElevenLabsKey =
        !clearElevenLabsKey && typeof storedVoice?.elevenlabs_api_key === 'string'
          ? storedVoice.elevenlabs_api_key
          : ''
      const hasElevenLabsKey = !!rawElevenLabsKey || !!storedElevenLabsKey

      if (transcriptionOn && !hasGeminiKey) {
        return bad(
          'To understand voice notes, add your Google Gemini key first. Nothing was saved.',
        )
      }
      if (replyOn && !transcriptionOn) {
        return bad(
          'Voice replies only work when "Understand voice notes" is switched on. Nothing was saved.',
        )
      }
      if (replyOn && !hasElevenLabsKey) {
        return bad(
          'To reply with voice notes, add your ElevenLabs key first. Nothing was saved.',
        )
      }
      if (replyOn && !voiceId) {
        return bad(
          'To reply with voice notes, add a Voice ID first. Nothing was saved.',
        )
      }

      // A new key is checked together with the voice. A key pasted before a
      // voice is chosen (replies are necessarily off then) is stored as-is
      // and checked once the voice id arrives — that's the second branch.
      if (voiceId && rawElevenLabsKey) {
        elevenLabsCheck = { apiKey: rawElevenLabsKey, voiceId }
      } else if (voiceId && voiceId !== storedVoiceId && storedElevenLabsKey) {
        try {
          // Decrypted only to make the check below; never logged or returned.
          elevenLabsCheck = { apiKey: decrypt(storedElevenLabsKey), voiceId }
        } catch {
          return bad(
            'The saved ElevenLabs key could not be read — enter it again. Nothing was saved.',
          )
        }
      }

      voiceWrite.voice_transcription_enabled = transcriptionOn
      voiceWrite.voice_reply_enabled = replyOn
      if (voiceIdProvided) voiceWrite.elevenlabs_voice_id = voiceId
      if (rawGeminiKey) voiceWrite.gemini_api_key = encrypt(rawGeminiKey)
      else if (clearGeminiKey) voiceWrite.gemini_api_key = null
      if (rawElevenLabsKey) {
        voiceWrite.elevenlabs_api_key = encrypt(rawElevenLabsKey)
      } else if (clearElevenLabsKey) {
        voiceWrite.elevenlabs_api_key = null
      }
    }

    // Reuse the stored key when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key')
      .eq('account_id', accountId)
      .maybeSingle()

    let apiKeyPlain: string
    if (rawKey) {
      apiKeyPlain = rawKey
    } else if (existing?.api_key) {
      try {
        apiKeyPlain = decrypt(existing.api_key)
      } catch {
        return bad('Stored API key could not be decrypted — re-enter your key.')
      }
    } else {
      return bad('api_key is required')
    }

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed. A save that just flips a toggle or
    // edits the system prompt on an existing, already-validated config
    // skips the call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      provider !== existing.provider ||
      model !== existing.model

    if (credentialsChanged) {
      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        })
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] validation error:', err)
        return bad('Could not validate the API key with the provider.')
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping'])
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] embeddings validation error:', err)
        return bad('Could not validate the embeddings key.')
      }
    }

    // Same "verify before save" for the two voice keys.
    if (rawGeminiKey) {
      try {
        await validateGeminiKey(rawGeminiKey)
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: notSaved('Gemini key: ', err.message), code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] Gemini validation error:', err)
        return bad('Could not check the Google Gemini key. Nothing was saved.')
      }
    }
    if (elevenLabsCheck) {
      try {
        await validateElevenLabsVoice(elevenLabsCheck)
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: notSaved('ElevenLabs: ', err.message), code: err.code },
            { status: 400 },
          )
        }
        console.error('[ai/config POST] ElevenLabs validation error:', err)
        return bad('Could not check the ElevenLabs key and voice. Nothing was saved.')
      }
    }

    const encryptedKey = rawKey ? encrypt(rawKey) : null
    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
    }
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId
    // Same write as the switches, so turning auto-reply on and restricting
    // it to test numbers land together or not at all — never an enabled,
    // unrestricted bot in between.
    if (testNumbersProvided) shared.auto_reply_test_numbers = testNumbers
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey)
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null
    }
    // Empty unless the form sent voice fields (see above).
    Object.assign(shared, voiceWrite)

    if (existing) {
      const { error: upErr } = await supabase
        .from('ai_configs')
        .update(encryptedKey ? { ...shared, api_key: encryptedKey } : shared)
        .eq('account_id', accountId)
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr)
        if (testNumbersProvided && upErr.code === '42703') return bad(MIGRATION_038_MISSING)
        if (voiceProvided && upErr.code === '42703') return bad(MIGRATION_039_MISSING)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    } else {
      const { error: insErr } = await supabase.from('ai_configs').insert({
        account_id: accountId,
        created_by: userId,
        api_key: encryptedKey, // guaranteed non-null: rawKey required when no existing row
        ...shared,
      })
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr)
        if (testNumbersProvided && insErr.code === '42703') return bad(MIGRATION_038_MISSING)
        if (voiceProvided && insErr.code === '42703') return bad(MIGRATION_039_MISSING)
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 },
        )
      }
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin')
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId)
    if (error) {
      console.error('[ai/config DELETE] error:', error)
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 },
      )
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
