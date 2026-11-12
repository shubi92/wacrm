import { supabaseAdmin } from './admin-client'
import { loadAiConfig } from './config'
import { buildConversationContext } from './context'
import { retrieveKnowledge } from './knowledge'
import { generateReply } from './generate'
import { buildSystemPrompt } from './defaults'
import {
  buildHandoffSummary,
  handoffFallbackMessage,
  isReplyCapSummary,
  replyCapSummary,
} from './handoff'
import { logAiUsage } from './usage'
import { latestUserMessage } from './query'
import { engineSendText } from '@/lib/flows/meta-send'
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit'
import { isTestNumberAllowed } from './test-numbers'
import {
  sendVoiceReply,
  transcribeInboundVoiceNote,
  type InboundVoiceNote,
} from './voice'
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver'
import type { HandoffLead } from './lead'
import type { AiConfig } from './types'

/** Why the bot handed a thread to a person — `data.reason` of the
 *  `conversation.handed_off` webhook (public contract). */
type HandoffReason =
  | 'customer_ready'
  | 'bot_cannot_help'
  | 'reply_cap'
  | 'voice_note_failed'
  | 'other'

/** How long a human/system outbound keeps the bot quiet on a thread —
 *  matches WhatsApp's 24h customer-service window. */
const HUMAN_ACTIVE_WINDOW_MS = 24 * 60 * 60 * 1000

/** How long a chat must be quiet — nothing sent to the customer by the
 *  bot, a teammate, a Flow or the API — before the bot starts over on
 *  it (see `startOverIfQuiet`). */
const QUIET_RESET_MS = 24 * 60 * 60 * 1000

const CONV_COLUMNS =
  'assigned_agent_id, ai_autoreply_disabled, ai_reply_count, ai_resumed_at, ai_handoff_summary'

interface DispatchArgs {
  /** Tenancy key — drives config, contact, and whatsapp_config lookups. */
  accountId: string
  conversationId: string
  contactId: string
  /** The account's WhatsApp config owner, used for the outbound send's
   *  audit columns (mirrors how the flow runner passes it through). */
  configOwnerUserId: string
  /** The sender's WhatsApp number as Meta gives it (digits, country code
   *  first) — reported on a handoff. `contacts.phone` is whatever a
   *  person typed or imported, so it is only the fallback. */
  fromPhone?: string
  /** Set when the inbound is a voice note (no typed text). The bot
   *  listens to it first, then answers the transcript like typed text. */
  voiceNote?: InboundVoiceNote
}

/**
 * AI auto-reply for a freshly-arrived inbound message.
 *
 * Invoked from the WhatsApp webhook's `after()` block, only when no
 * deterministic flow consumed the message (flows win). Mirrors the flow
 * runner's contract: it owns its try/catch and NEVER throws — a failing
 * or slow LLM call must not affect the webhook's 200 to Meta.
 *
 * Eligibility gates (any → silent no-op):
 *   - AI off / auto-reply disabled for the account
 *   - the account set test numbers and this contact isn't one of them
 *   - a human agent is assigned (they own the thread)
 *   - auto-reply was disabled for this conversation (prior handoff)
 *   - a non-AI outbound message went to this thread in the last 24h
 *     (checked before generation and again right before sending)
 *   - there's nothing to reply to
 *
 * A chat that has been quiet for a day starts over first: a fresh reply
 * budget, and a pause that only the reply cap caused is lifted (see
 * `startOverIfQuiet`).
 *
 * At the per-conversation reply cap the bot sends no further answer,
 * but it still reads the message: a customer saying yes right then is
 * handed over with their details, and anything else is handed to a
 * person instead of being met with silence.
 *
 * Every handoff — cap, voice note, the model's own, or a customer who
 * said yes (with lead details) — fires `conversation.handed_off` once.
 *
 * A voice note passes the same gates, then is turned into text (only
 * when the account switched that on — otherwise silence, as before). If
 * it can't be understood the thread is handed to a person, never left
 * unanswered.
 *
 * The 24h WhatsApp session window is inherently open here — we're
 * reacting to a customer message that just landed — so no separate
 * window check is needed.
 */
export async function dispatchInboundToAiReply(
  args: DispatchArgs,
): Promise<void> {
  const { accountId, conversationId, contactId, configOwnerUserId } = args

  try {
    const db = supabaseAdmin()

    const config = await loadAiConfig(db, accountId)
    if (!config || !config.autoReplyEnabled) return

    if (!(await contactPassesTestNumbers(db, accountId, contactId))) return

    // Deterministic, user-configured responders win over the LLM — the
    // caller already excludes messages a Flow consumed. Message-level
    // automations (`new_message_received` / `keyword_match`) are
    // dispatched independently for this same inbound and may send their
    // own reply, so if the account has any active one we stand down to
    // avoid double-texting the customer. (Relationship triggers like
    // `first_inbound_message` don't count — they're not per-message
    // auto-responders.)
    const { data: autoResponders } = await db
      .from('automations')
      .select('id')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .in('trigger_type', ['new_message_received', 'keyword_match'])
      .limit(1)
    if (autoResponders && autoResponders.length > 0) return

    const readConv = () =>
      db.from('conversations').select(CONV_COLUMNS).eq('id', conversationId).maybeSingle()
    let { data: conv, error: convErr } = await readConv()
    if (convErr || !conv) return
    if (conv.assigned_agent_id) return // a human owns this thread
    if (await startOverIfQuiet(db, conversationId, conv)) {
      // Re-read rather than assume: another inbound, or a person, may
      // have changed the thread in the same instant.
      ;({ data: conv, error: convErr } = await readConv())
      if (convErr || !conv || conv.assigned_agent_id) return
    }
    if (conv.ai_autoreply_disabled) return // handed off / turned off here

    // Someone other than the bot is already talking to this customer (see
    // `othersActiveOnThread`). Checked again after generation, below.
    if (await othersActiveOnThread(db, conversationId, conv.ai_resumed_at)) return

    const handoffBase = {
      accountId,
      contactId,
      conversationId,
      config,
      conv,
      fromPhone: args.fromPhone,
    }

    // Out of replies. The bot may not answer again, but it still reads
    // this message — it is often the "yes" to a price in its last reply —
    // and then hands the thread to a person either way (below).
    // (The authoritative cap check for sending is the atomic claim; this
    // read can only lag a concurrent inbound, never run ahead.)
    const atCap = conv.ai_reply_count >= config.autoReplyMaxPerConversation

    // Voice note: listen first. Deliberately AFTER every gate above, so a
    // customer's audio only leaves the system for a thread the bot may
    // actually answer (test numbers included). The transcript is saved on
    // the message, so the context below picks it up like typed text.
    // ponytail: one Gemini call per eligible voice note, not covered by
    // the account rate limit below; add a limiter if cost ever matters.
    if (args.voiceNote) {
      const heard = await transcribeInboundVoiceNote(db, {
        accountId,
        conversationId,
        voiceNote: args.voiceNote,
      })
      if (heard.status === 'off') return
      if (heard.status === 'failed') {
        const { notified } = await handOff(db, {
          ...handoffBase,
          reason: 'voice_note_failed',
          summary: `🤖 AI agent handed off: ${heard.reason} Please listen to it and reply.`,
        })
        await notified
        return
      }
    }

    const messages = await buildConversationContext(db, conversationId)
    if (messages.length === 0) return

    // Account-wide throttle on the shared BYO key. The per-conversation
    // cap bounds one thread; this bounds a burst across many threads (a
    // marketing blast landing 200 replies at once) so we never run the
    // owner's key past the provider's rate limit. Over the limit → skip
    // the auto-reply; the inbound still sits in the inbox for a human.
    const acctLimit = checkRateLimit(
      `ai-autoreply:${accountId}`,
      RATE_LIMITS.aiAutoReplyAccount,
    )
    if (!acctLimit.success) {
      console.warn(
        `[ai auto-reply] account ${accountId} hit the per-account rate limit — skipping this inbound.`,
      )
      return
    }

    // Ground the reply in the account's knowledge base (best-effort).
    const knowledge = await retrieveKnowledge(
      db,
      accountId,
      config,
      latestUserMessage(messages),
    )

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'auto_reply',
      knowledge,
      resumed: !!conv.ai_resumed_at,
    })

    const { text, handoff, lead, ready, leadUnreadable, usage, tagged, raw, retried } = await generateReply({
      config,
      systemPrompt,
      messages,
    })

    // Record token spend on the account's BYO key. Fire-and-forget so it
    // never adds latency to the customer-facing send: `logAiUsage`
    // swallows its own errors, so the floating promise can't reject.
    // Logged regardless of handoff — the provider call happened either
    // way.
    void logAiUsage(db, {
      accountId,
      conversationId,
      mode: 'auto_reply',
      provider: config.provider,
      model: config.model,
      usage,
    })

    // Only a complete <reply> block is safe to send: untagged output (or a
    // block cut off by the token limit) may carry the model's reasoning.
    // `generateReply` already asked the model a second time; what is still
    // unusable is treated like a handoff — a human answers instead — and
    // never sent.
    if (!handoff && (!tagged || !text)) {
      console.warn(
        `[ai auto-reply] unsendable model output on conversation ${conversationId}${retried ? ' (after a second try)' : ''} — handing off instead of sending it.`,
      )
    }

    if (handoff || !text || !tagged || atCap) {
      // The model can't (or shouldn't, or may no longer) answer — hand
      // the thread to a human (see `handOff`). Only the winner sends the
      // goodbye below.
      // Whatever the bot collected (`lead`) goes along on every handoff;
      // `ready` — the customer said yes — only decides the reason. A lead
      // block we couldn't read degrades to a plain handoff, never a lost one.
      // `capOnly`: a perfectly good reply the bot has no slot left to send.
      const capOnly = atCap && !handoff && !!text && tagged
      const { won, notified } = await handOff(db, {
        ...handoffBase,
        reason: ready
          ? 'customer_ready'
          : capOnly
            ? 'reply_cap'
            : handoff && !leadUnreadable
              ? 'bot_cannot_help'
              : 'other',
        lead,
        summary: capOnly
          ? replyCapSummary(config.autoReplyMaxPerConversation)
          : buildHandoffSummary({
              messages,
              replyCount: conv.ai_reply_count ?? 0,
              lead,
              ready,
              leadUnreadable,
              unsendable: handoff ? undefined : { raw, retried },
            }),
      })

      // A handoff can carry a short message for the customer ("a colleague
      // will contact you shortly"). When the model wrote none we may send
      // — it handed off bare, its output was unusable, or the cap withheld
      // an ordinary reply — a standard line goes instead: the customer is
      // never left in silence. Sent after the handoff is recorded, and
      // skipped if a human replied while the model was generating —
      // they're already talking to the customer.
      const goodbye =
        text && tagged && handoff ? text : handoffFallbackMessage(latestUserMessage(messages))
      try {
        if (
          won &&
          !(await othersActiveOnThread(db, conversationId, conv.ai_resumed_at)) &&
          (await contactPassesTestNumbers(db, accountId, contactId))
        ) {
          await engineSendText({
            accountId,
            userId: configOwnerUserId,
            conversationId,
            contactId,
            text: goodbye,
            aiGenerated: true,
          })
        }
      } finally {
        // The webhook went out alongside the goodbye, so a slow receiver
        // can't delay the customer; wait for it before `after()` ends.
        await notified
      }
      return
    }

    // Generation takes seconds — a teammate or the API may have replied
    // meanwhile. Re-check right before sending. (Narrows, doesn't close,
    // the window; strict serialization would need a conversation lock.)
    if (await othersActiveOnThread(db, conversationId, conv.ai_resumed_at)) return
    // Paused-then-resumed while we were generating? Our reply answers an
    // older state of the thread — drop it before it consumes a fresh slot.
    if (!(await stillOursToAnswer(db, conversationId, conv.ai_resumed_at))) return

    // Atomically claim a reply slot: the cap check + increment happen in
    // one UPDATE, so concurrent inbounds can never overshoot the cap. If
    // another inbound just took the last slot, `claimed` is false and we
    // skip the send. (We consume a slot slightly before the send lands —
    // fail-safe: under-reply rather than over-reply.)
    const { data: claimed, error: claimErr } = await db.rpc(
      'claim_ai_reply_slot',
      {
        conversation_id: conversationId,
        max_replies: config.autoReplyMaxPerConversation,
      },
    )
    if (claimErr) {
      // A real error here (vs. losing the cap race) is almost always a
      // deploy issue — e.g. `claim_ai_reply_slot` not EXECUTE-able by the
      // service role, or the migration not applied. Log it loudly: a
      // silent return makes "auto-reply never fires" undiagnosable.
      console.error('[ai auto-reply] claim_ai_reply_slot failed:', claimErr)
      return
    }
    if (claimed !== true) return // lost the per-conversation cap race

    // A racing inbound may have handed this thread off (and sent its
    // goodbye), or a teammate may have taken it, after our eligibility
    // read. Re-check ownership — and the test-number list, in case the
    // contact's phone was edited — right before sending.
    // ponytail: narrows the window to milliseconds, doesn't close it;
    // a strict guarantee needs a per-conversation send lock/outbox.
    if (!(await stillOursToAnswer(db, conversationId, conv.ai_resumed_at))) return
    if (!(await contactPassesTestNumbers(db, accountId, contactId))) return

    await engineSendText({
      accountId,
      userId: configOwnerUserId,
      conversationId,
      contactId,
      text,
      aiGenerated: true,
    })

    // They spoke, so answer in voice too — after the text, which is the
    // part that must arrive. No-op unless voice replies are switched on;
    // owns its errors.
    if (args.voiceNote) {
      await sendVoiceReply(db, {
        accountId,
        userId: configOwnerUserId,
        conversationId,
        contactId,
        text,
      })
    }
  } catch (err) {
    console.error('[ai auto-reply] dispatch failed:', err)
  }
}

/**
 * Stop auto-replying on this thread and hand it to a human: pause the
 * bot here (sticky until re-enabled), route the conversation to the
 * configured handoff agent — null leaves it in the shared queue — and
 * leave a short internal note so whoever picks it up has context.
 * Assigning fires the `on_conversation_assigned` trigger, which notifies
 * the agent.
 *
 * `won` is true only when this call won the handoff. The update is
 * guarded so a stale generation can't win: the thread must still be
 * bot-owned exactly as it was when we read it — not paused (a racing
 * handoff), not assigned to a human (someone took it over meanwhile),
 * and not resumed since (a newer "Resume AI").
 *
 * The winner — and only the winner, so once per handoff — also fires
 * the `conversation.handed_off` webhook. `notified` settles when that
 * delivery is done and never rejects; await it before returning.
 */
async function handOff(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    contactId: string
    config: AiConfig
    conv: { assigned_agent_id: string | null; ai_resumed_at?: string | null }
    conversationId: string
    reason: HandoffReason
    summary: string
    lead?: HandoffLead | null
    fromPhone?: string
  },
): Promise<{ won: boolean; notified: Promise<void> }> {
  const { config, conv, conversationId, summary } = args
  const update: Record<string, unknown> = {
    ai_autoreply_disabled: true,
    ai_handoff_summary: summary,
  }
  // Only set the assignee when a target is configured AND the thread
  // isn't already owned — never stomp an existing human assignment.
  if (config.handoffAgentId && !conv.assigned_agent_id) {
    update.assigned_agent_id = config.handoffAgentId
  }
  let guarded = db
    .from('conversations')
    .update(update)
    .eq('id', conversationId)
    .eq('ai_autoreply_disabled', false)
    .is('assigned_agent_id', null)
  guarded = conv.ai_resumed_at
    ? guarded.eq('ai_resumed_at', conv.ai_resumed_at)
    : guarded.is('ai_resumed_at', null)
  const { data: rows, error } = await guarded.select('id')
  // Without this a database failure would look exactly like losing the
  // race: no pause, no event, and nothing to find it by.
  if (error) console.error('[ai auto-reply] handoff update failed:', error)
  const won = (rows?.length ?? 0) > 0
  return { won, notified: won ? notifyHandoff(db, args) : Promise.resolve() }
}

/** Tell subscribed systems (e.g. the business's CRM) about a handoff.
 *  Best-effort; never rejects. */
async function notifyHandoff(
  db: ReturnType<typeof supabaseAdmin>,
  args: {
    accountId: string
    contactId: string
    conversationId: string
    reason: HandoffReason
    summary: string
    lead?: HandoffLead | null
    fromPhone?: string
  },
): Promise<void> {
  try {
    const handedOffAt = new Date().toISOString()
    const { data: contact } = await db
      .from('contacts')
      .select('phone, name')
      .eq('id', args.contactId)
      .maybeSingle()
    await dispatchWebhookEvent(db, args.accountId, 'conversation.handed_off', {
      conversation_id: args.conversationId,
      contact: {
        id: args.contactId,
        // Digits only, country code first — Meta's own form of the
        // number when we have it.
        phone: String(args.fromPhone || contact?.phone || '').replace(/\D/g, ''),
        name: (contact?.name as string | null | undefined)?.trim() || null,
      },
      reason: args.reason,
      summary: args.summary,
      handed_off_at: handedOffAt,
      // Whatever the bot collected, for any reason; `reason` alone says
      // whether the customer said yes.
      lead: args.lead ?? null,
    })
  } catch (err) {
    console.error('[ai auto-reply] handoff webhook failed:', err)
  }
}

/**
 * A chat that has been quiet for a day starts over. The customer who
 * comes back gets a fresh reply budget, and a pause that only the reply
 * cap caused is lifted — otherwise the cap would be for life, since a
 * contact keeps one conversation forever.
 *
 * "Quiet" = nothing was sent to the customer on this chat in the last
 * 24h: not by the bot (its goodbye included), a teammate, a Flow or the
 * API. The customer's own messages don't count, so writing again while
 * waiting never keeps the bot locked out.
 *
 * Left alone: a thread a human is assigned to (the caller returns
 * before this), and a thread paused for any other reason — by a person,
 * or by a handoff the cap didn't cause. Those stay with the team.
 *
 * Returns true when a start-over was attempted; the caller re-reads the
 * thread. The update is compare-and-swap on `ai_resumed_at`, which it
 * also sets: of several inbounds arriving together only one starts the
 * chat over, and nothing can do so again for 24h. So, with the atomic
 * slot claim, a chat gets at most one fresh budget per quiet day.
 */
async function startOverIfQuiet(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  conv: {
    ai_autoreply_disabled: boolean
    ai_reply_count: number
    ai_resumed_at?: string | null
    ai_handoff_summary?: string | null
  },
): Promise<boolean> {
  const nothingToReset = conv.ai_autoreply_disabled
    ? !isReplyCapSummary(conv.ai_handoff_summary)
    : !conv.ai_reply_count
  if (nothingToReset) return false

  // Taken BEFORE the quiet check and written as the new `ai_resumed_at`,
  // so a teammate's reply landing after the check still counts as
  // "someone else is talking" for the reply being generated.
  const now = Date.now()
  const quietSince = now - QUIET_RESET_MS
  if (conv.ai_resumed_at && Date.parse(conv.ai_resumed_at) > quietSince) return false

  const { data: recent, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .gte('created_at', new Date(quietSince).toISOString())
    .limit(1)
  if (error || (recent?.length ?? 0) > 0) return false

  let guarded = db
    .from('conversations')
    .update({
      ai_autoreply_disabled: false,
      ai_reply_count: 0,
      ai_handoff_summary: null,
      ai_resumed_at: new Date(now).toISOString(),
    })
    .eq('id', conversationId)
    .eq('ai_autoreply_disabled', conv.ai_autoreply_disabled)
    .is('assigned_agent_id', null)
  guarded = conv.ai_resumed_at
    ? guarded.eq('ai_resumed_at', conv.ai_resumed_at)
    : guarded.is('ai_resumed_at', null)
  const { error: resetErr } = await guarded.select('id')
  if (resetErr) console.error('[ai auto-reply] quiet-day reset failed:', resetErr)
  return true
}

/**
 * True while the thread is still the bot's, exactly as this generation
 * found it: not paused, not assigned to a human, and not resumed since
 * (`ai_resumed_at` unchanged). A read error counts as "not ours".
 */
async function stillOursToAnswer(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  resumedAtWhenRead: string | null | undefined,
): Promise<boolean> {
  const { data, error } = await db
    .from('conversations')
    .select('assigned_agent_id, ai_autoreply_disabled, ai_resumed_at')
    .eq('id', conversationId)
    .maybeSingle()
  if (error || !data) return false
  if (data.ai_autoreply_disabled || data.assigned_agent_id) return false
  return (data.ai_resumed_at ?? null) === (resumedAtWhenRead ?? null)
}

/**
 * True when someone other than the bot messaged this customer within the
 * session window — a teammate in the inbox, a Flow/Automation, or an
 * external system sending through the public API (e.g. a CRM's booking
 * messages, stored as sender_type='agent'). None of those assign an
 * agent, so the `assigned_agent_id` gate can't see them. A read error
 * also counts as active (under-reply rather than over-reply).
 *
 * Broadcasts don't write `messages` rows, so a reply to a recent
 * broadcast stays eligible — deliberately: that's a fresh inquiry.
 *
 * The window starts no earlier than the last "Resume AI" click, so a
 * teammate who replied and then handed the thread back isn't counted.
 */
async function othersActiveOnThread(
  db: ReturnType<typeof supabaseAdmin>,
  conversationId: string,
  resumedAt: string | null | undefined,
): Promise<boolean> {
  const windowStart = Date.now() - HUMAN_ACTIVE_WINDOW_MS
  const resumed = resumedAt ? Date.parse(resumedAt) : NaN
  const since = new Date(
    resumed > windowStart ? resumed : windowStart,
  ).toISOString()
  const { data, error } = await db
    .from('messages')
    .select('id')
    .eq('conversation_id', conversationId)
    .in('sender_type', ['agent', 'bot'])
    .eq('ai_generated', false)
    .gte('created_at', since)
    .limit(1)
  return !!error || (data?.length ?? 0) > 0
}

/**
 * While an account trials the bot, `ai_configs.auto_reply_test_numbers`
 * limits it to those phones; empty/NULL means everyone. Read separately
 * from `loadAiConfig` so the rest of AI keeps working on a database that
 * hasn't run migration 038 yet — but a failed read fails CLOSED (no
 * reply): an admin who set test numbers must never see the bot answer
 * real customers because a lookup errored.
 */
async function contactPassesTestNumbers(
  db: ReturnType<typeof supabaseAdmin>,
  accountId: string,
  contactId: string,
): Promise<boolean> {
  const { data: cfg, error } = await db
    .from('ai_configs')
    .select('auto_reply_test_numbers')
    .eq('account_id', accountId)
    .maybeSingle()
  if (error) {
    console.error('[ai auto-reply] test-numbers lookup failed (migration 038 applied?):', error)
    return false
  }
  const testNumbers = (cfg?.auto_reply_test_numbers as string[] | null) ?? []
  if (testNumbers.length === 0) return true

  const { data: contact } = await db
    .from('contacts')
    .select('phone')
    .eq('id', contactId)
    .maybeSingle()
  return isTestNumberAllowed(contact?.phone as string | undefined, testNumbers)
}
