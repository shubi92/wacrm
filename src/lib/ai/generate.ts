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
import { hasLeadBlock, parseLeadBlock, stripLeadBlocks } from './lead'

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
 * Split the raw model output into `{ text, handoff, lead, … }`. The
 * sentinel can appear alone or trailing a partial reply; either way we
 * treat the turn as a handoff and strip the marker from any remaining
 * text. A `<lead>` block (see `./lead`) marks a customer who said yes:
 * it is a handoff too, with or without the sentinel, and is never part
 * of the customer-visible text. `usage` is passed straight through (null
 * when the provider didn't report it).
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  const { body, tail, tagged } = extractReply(raw)
  // With tags, only the reply itself or what follows it counts as a
  // handoff request. Reasoning before the tags can mention the markers
  // ("no need to emit [[HANDOFF]]") without meaning it.
  const signals = tagged ? body + tail : raw
  // A complete, valid lead block counts wherever the model put it (some
  // write it before the reply); a bare mention of the tag does not.
  const lead = parseLeadBlock(raw)
  const leadBlock = hasLeadBlock(signals)
  const handoff = signals.includes(HANDOFF_SENTINEL) || leadBlock || lead !== null
  const text = stripLeadBlocks(body).split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, lead, leadUnreadable: tagged && leadBlock && !lead, usage, tagged }
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
