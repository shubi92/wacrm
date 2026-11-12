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
import { hasLeadTag, maskLeadBlocks, parseLeadBlock } from './lead'

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
  const { config, systemPrompt } = args
  // The model is asked to answer inside <reply> tags, so it must see the
  // business's earlier turns the same way. Shown bare, they are examples
  // of answering WITHOUT tags for the model to copy.
  const messages = args.messages.map((m) =>
    m.role === 'assistant' ? { ...m, content: `<reply>${m.content}</reply>` } : m,
  )
  let generate: typeof generateOpenAi
  switch (config.provider) {
    case 'openai':
      generate = generateOpenAi
      break
    case 'anthropic':
      generate = generateAnthropic
      break
    default:
      throw new AiError(`Unsupported AI provider: ${config.provider}`, {
        code: 'unsupported_provider',
        status: 400,
      })
  }
  // One time budget for the whole turn, second try included.
  const deadline = Date.now() + aiRequestTimeoutMs()
  const attempt = async (prompt: string, spent: AiUsage | null) => {
    const { text, usage } = await generate({
      apiKey: config.apiKey,
      model: config.model,
      systemPrompt: prompt,
      messages,
      timeoutMs: Math.max(1, deadline - Date.now()),
    })
    return parseGeneration(text, addUsage(spent, usage))
  }

  const first = await attempt(systemPrompt, null)
  // A formatting slip — the model did not ask to hand off, yet wrote
  // nothing that may be sent — gets one more try before the caller gives
  // the thread to a person. A handoff the model chose is never retried.
  const slipped = !first.handoff && (!first.tagged || !first.text)
  if (!slipped || deadline - Date.now() < MIN_RETRY_MS) return first
  try {
    return { ...(await attempt(`${systemPrompt}\n\n${RETRY_NOTE}`, first.usage)), retried: true }
  } catch (err) {
    // The first answer still stands (and its tokens were still spent).
    console.error('[ai] second try after an unsendable answer failed:', err instanceof Error ? err.message : err)
    return { ...first, retried: true }
  }
}

/** Not worth starting a second try with less time than this left. */
const MIN_RETRY_MS = 5_000

const RETRY_NOTE =
  'Your previous answer to this turn was discarded: it did not contain a complete <reply>…</reply> block with a message in it. ' +
  'Answer again. Put the exact message for the customer inside <reply></reply> tags and close the tag.'

function addUsage(a: AiUsage | null, b: AiUsage | null): AiUsage | null {
  if (!a || !b) return a ?? b
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
  }
}

/**
 * Split the raw model output into `{ text, handoff, lead, ready, … }`.
 * The sentinel can appear alone or trailing a partial reply; either way
 * we treat the turn as a handoff and strip the marker from any remaining
 * text. A `<lead>` block (see `./lead`) carries what the bot collected
 * and whether the customer said yes (`ready` — a handoff in itself); it
 * is never part of the customer-visible text. `usage` is passed straight
 * through (null when the provider didn't report it); `raw` is the output
 * untouched, for diagnostics.
 */
export function parseGeneration(
  raw: string,
  usage: AiUsage | null = null,
): GenerateResult {
  // Lead blocks are swapped for a marker first, so text inside one can
  // never pose as the reply or the handoff marker.
  const masked = maskLeadBlocks(raw.split(LEAD_MARK).join(''), LEAD_MARK)
  const { body, tail, tagged } = extractReply(masked)
  // With tags, only the reply itself or what follows it counts as a
  // handoff request. Reasoning before the tags can mention the markers
  // ("no need to emit [[HANDOFF]]") without meaning it.
  const signals = tagged ? body + tail : masked
  // A complete, valid lead block counts wherever the model put it (some
  // write it before the reply); a bare mention of the tag does not.
  const parsed = parseLeadBlock(raw)
  const lead = parsed?.lead ?? null
  const ready = parsed?.ready ?? false
  // A block where it counts that we could not read: the model meant to
  // pass something on, so the turn is still a handoff — never a lost one.
  const leadUnreadable = !lead && (signals.includes(LEAD_MARK) || hasLeadTag(signals))
  // A customer saying yes is a handoff with or without the marker. Lead
  // details alone are not: they only ride along when the bot hands off.
  const handoff = signals.includes(HANDOFF_SENTINEL) || ready || leadUnreadable
  // A whole block inside the reply is cut out cleanly. Any other trace of
  // a lead tag there (cut off, or broken by what a customer typed) means
  // reply and data can't be told apart — so nothing is sent.
  const reply = body.split(LEAD_MARK).join('')
  const text = hasLeadTag(reply) ? '' : reply.split(HANDOFF_SENTINEL).join('').trim()
  return { text, handoff, lead, ready, leadUnreadable: tagged && leadUnreadable, usage, tagged, raw, retried: false }
}

/** Stands in for a lead block while the output is parsed; never valid
 *  in model output (stripped from it first). */
const LEAD_MARK = '\u0000'

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
