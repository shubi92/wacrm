import type { HandoffLead } from './lead'
// ============================================================
// Shared types for the AI reply assistant (bring-your-own-key).
//
// One small provider-agnostic surface so the inbox draft route and the
// inbound auto-reply bot both talk to `generateReply` without caring
// whether the account is on OpenAI or Anthropic.
// ============================================================

export type AiProvider = 'openai' | 'anthropic'

/**
 * Account AI setup, decrypted and ready to use. Produced by
 * `loadAiConfig` — `apiKey` is the plaintext BYO provider key
 * (stored AES-256-GCM-encrypted at rest).
 */
export interface AiConfig {
  provider: AiProvider
  model: string
  apiKey: string
  systemPrompt: string | null
  isActive: boolean
  autoReplyEnabled: boolean
  autoReplyMaxPerConversation: number
  /** Where auto-reply hands a conversation off when the model bails: an
   *  agent's `auth.users.id`, or null to leave it unassigned (drop into
   *  the shared queue). */
  handoffAgentId: string | null
  /** Optional OpenAI-compatible key for embeddings. When set, the
   *  knowledge base is embedded and semantic retrieval turns on; when
   *  null, retrieval falls back to lexical full-text search. */
  embeddingsApiKey: string | null
}

/** Voice-note settings, decrypted. Everything off / null when not set up. */
export interface VoiceConfig {
  transcriptionEnabled: boolean
  replyEnabled: boolean
  geminiApiKey: string | null
  elevenLabsApiKey: string | null
  elevenLabsVoiceId: string | null
}

/** A single conversation turn in the shape both providers accept. */
export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

/**
 * Token counts for one provider call, normalized across OpenAI
 * (`prompt`/`completion`) and Anthropic (`input`/`output`). Null when
 * the provider didn't return usage. Logged to `ai_usage_log`.
 */
export interface AiUsage {
  promptTokens: number
  completionTokens: number
  totalTokens: number
}

/** Raw text + usage a provider adapter returns before handoff parsing. */
export interface ProviderResult {
  text: string
  usage: AiUsage | null
}

/** Outcome of a generation call. */
export interface GenerateResult {
  /** The reply text, with any handoff sentinel stripped. */
  text: string
  /** True when the model asked to hand off to a human (auto-reply mode). */
  handoff: boolean
  /** What the bot collected from the customer (auto-reply mode), or
   *  null when it wrote no lead block. Passed on with a handoff. */
  lead: HandoffLead | null
  /** The customer said yes. Implies `handoff` and a non-null `lead`. */
  ready: boolean
  /** The model wrote a lead block that could not be read — the turn is
   *  handled as a plain handoff, without details. */
  leadUnreadable: boolean
  /** Provider token usage for this call, or null when unavailable. */
  usage: AiUsage | null
  /**
   * True when the output carried a complete <reply>…</reply> block. The
   * auto-reply bot only sends tagged replies; anything else (no tags, or
   * a block cut off by the token limit) may contain the model's reasoning.
   */
  tagged: boolean
  /** The model's output exactly as it came. For diagnostics only (the
   *  handoff note, the Playground) — never for a customer. */
  raw: string
  /** The first answer could not be sent and was not a handoff, so the
   *  model was asked once more; this is the outcome of that. */
  retried: boolean
}

/**
 * Typed error for every AI failure mode. `status` maps cleanly to an
 * HTTP response in the draft route; `code` lets the UI/tests branch
 * (invalid_key vs rate_limited vs timeout, etc.).
 */
export class AiError extends Error {
  readonly code: string
  readonly status: number
  constructor(message: string, opts: { code?: string; status?: number } = {}) {
    super(message)
    this.name = 'AiError'
    this.code = opts.code ?? 'ai_error'
    this.status = opts.status ?? 502
  }
}
