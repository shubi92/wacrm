import {
  AiError,
  type AiConfig,
  type AiUsage,
  type ChatMessage,
  type GenerateResult,
} from './types'
import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from './defaults'
import { generateOpenAi } from './providers/openai'
import { generateAnthropic } from './providers/anthropic'

export interface GenerateArgs {
  config: AiConfig
  /** Fully-built system prompt (see `buildSystemPrompt`). */
  systemPrompt: string
  /** Recent conversation turns, oldest first. */
  messages: ChatMessage[]
}

/**
 * Generate the next reply from the account's configured provider.
 * Dispatches to the right adapter, then parses the handoff sentinel out
 * of the raw text. Throws `AiError` on any provider/network failure.
 */
export async function generateReply(args: GenerateArgs): Promise<GenerateResult> {
  const { config, systemPrompt, messages } = args
  const timeoutMs = aiRequestTimeoutMs()
  const providerArgs = {
    apiKey: config.apiKey,
    model: config.model,
    systemPrompt,
    messages,
    timeoutMs,
  }

  let result: { text: string; usage: AiUsage | null }
  switch (config.provider) {
    case 'openai':
      result = await generateOpenAi(providerArgs)
      break
    case 'anthropic':
      result = await generateAnthropic(providerArgs)
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }

  return parseGeneration(result.text, result.usage)
}

/**
 * Split the raw model output into `{ text, handoff, usage }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. `usage` is passed straight through (null when the provider
 * didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const { body, tail, tagged } = extractReply(raw)
  // With tags, only the reply itself or what follows it counts as a
  // handoff request. Reasoning before the tags can mention the marker
  // ("no need to emit [[HANDOFF]]") without meaning it.
  const handoff = tagged
    ? body.includes(HANDOFF_SENTINEL) || tail.includes(HANDOFF_SENTINEL)
    : raw.includes(HANDOFF_SENTINEL)
  const text = body.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, usage, tagged }
}

/**
 * The prompt asks the model to wrap the customer-facing message in
 * <reply>…</reply>. Models given long rule sets sometimes "think out
 * loud" first ("Customer asks the price… per the rules…"); that must
 * never reach a customer on WhatsApp. Keep only the last <reply> block.
 * `tagged` is true only for a complete block; no tags (or a block the
 * token limit cut off) returns the best-effort text with tagged=false,
 * which drafts may still show but the auto-reply bot will not send.
 */
function extractReply(raw: string): { body: string; tail: string; tagged: boolean } {
  const open = raw.lastIndexOf('<reply>')
  if (open === -1) return { body: raw, tail: '', tagged: false }
  const start = open + '<reply>'.length
  const close = raw.indexOf('</reply>', start)
  if (close === -1) return { body: raw.slice(start), tail: '', tagged: false }
  return {
    body: raw.slice(start, close),
    tail: raw.slice(close + '</reply>'.length),
    tagged: true,
  }
}
