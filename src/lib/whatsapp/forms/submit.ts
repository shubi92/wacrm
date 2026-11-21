// ============================================================
// A customer sent a form from /form/<token>.
//
// This is a public endpoint's core: the token is the only proof of who
// is sending, and nothing in the body is trusted until the form's own
// `validate` has passed it.
// ============================================================

import { supabaseAdmin } from '@/lib/ai/admin-client'
import { dispatchFormSubmissionToAiReply } from '@/lib/ai/auto-reply'
import { BOT_FORMS } from './index'
import { findFormLink } from './links'
import type { FieldError } from './furniture-moving'

export type SubmitResult =
  /** Stored in the chat. `followUp` thanks the customer and hands the
   *  chat over; it never throws. */
  | { status: 'accepted'; followUp: () => Promise<void> }
  /** This link was sent before: nothing new happens. */
  | { status: 'already' }
  /** Unknown, altered or expired link. */
  | { status: 'gone' }
  | { status: 'invalid'; fields: Record<string, FieldError> }

/**
 * Check and store one submission. Using the link up and storing the
 * message is one database transaction that only one request can win, so
 * a double tap (or a replay) never makes a second message or a second
 * handoff. Throws if the database fails; nothing is stored then, the
 * link stays open and the customer is asked to try again.
 */
export async function submitForm(token: string, raw: unknown): Promise<SubmitResult> {
  const db = supabaseAdmin()
  const state = await findFormLink(db, token)
  if (state.status === 'invalid') return { status: 'gone' }
  if (state.status === 'submitted') return { status: 'already' }
  const { link } = state
  if (!Object.hasOwn(BOT_FORMS, link.form)) return { status: 'gone' }
  const form = BOT_FORMS[link.form]

  const checked = form.validate(raw)
  if (!checked.ok) return { status: 'invalid', fields: checked.fields }

  // One database call uses the link up and stores the message, together
  // or not at all (`submit_form_link`, migration 041).
  const submission = form.read(checked.answers)
  const { data: stored, error } = await db.rpc('submit_form_link', {
    p_id: link.id,
    p_answers: checked.answers,
    p_text: submission.text,
  })
  if (error) throw new Error(`form submit failed: ${error.message}`)
  if (!stored) {
    // Another request got there first, or the link ran out meanwhile.
    return (await findFormLink(db, token)).status === 'submitted'
      ? { status: 'already' }
      : { status: 'gone' }
  }

  const now = new Date().toISOString()
  const { data: conversation } = await db
    .from('conversations')
    .select('unread_count')
    .eq('id', link.conversation_id)
    .maybeSingle()
  const { error: convError } = await db
    .from('conversations')
    .update({
      // The answers run to many lines; the chat list shows the title.
      last_message_text: submission.text.split('\n')[0],
      last_message_at: now,
      unread_count: ((conversation?.unread_count as number | null) ?? 0) + 1,
      updated_at: now,
    })
    .eq('id', link.conversation_id)
  if (convError) console.error('[forms] conversation update failed:', convError)

  return {
    status: 'accepted',
    followUp: async () => {
      try {
        const { data: config } = await db
          .from('whatsapp_config')
          .select('user_id')
          .eq('account_id', link.account_id)
          .maybeSingle()
        if (!config?.user_id) return
        await dispatchFormSubmissionToAiReply({
          accountId: link.account_id,
          conversationId: link.conversation_id,
          contactId: link.contact_id,
          configOwnerUserId: config.user_id as string,
          submission,
        })
      } catch (err) {
        console.error('[forms] follow-up failed:', err)
      }
    },
  }
}
