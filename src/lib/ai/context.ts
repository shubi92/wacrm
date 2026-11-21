import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { FORM_SENT_NOTE } from '@/lib/whatsapp/forms'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  ai_generated?: boolean | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Other non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * One interactive message does count: the bot's own line that went out
 * with a form's button. Without it the bot can't see that it
 * already sent the form, and sends it again. It is marked so the bot can
 * tell it from a plain line.
 *
 * A customer's voice note counts as text once it has been transcribed:
 * the transcript lives in the audio row's `content_text`. Rows with no
 * text are left out in the query itself, so untranscribed voice notes
 * don't use up the window. Outbound audio never counts — any text on it
 * was not delivered to the customer.
 *
 * Ordered oldest-first (chronological) so the transcript reads
 * naturally and the most recent customer message lands last.
 */
export async function buildConversationContext(
  db: SupabaseClient,
  conversationId: string,
  limit: number = aiContextMessageLimit(),
): Promise<ChatMessage[]> {
  const { data, error } = await db
    .from('messages')
    .select('sender_type, content_type, content_text, ai_generated')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio', 'interactive'])
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  // The only interactive message the auto-reply bot itself sends.
  const isBotForm = (m: DbMessage) =>
    m.content_type === 'interactive' && m.sender_type === 'bot' && m.ai_generated === true
  return rows
    .filter(
      (m) =>
        m.content_type === 'text' ||
        (m.content_type === 'audio' && m.sender_type === 'customer') ||
        isBotForm(m),
    )
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: isBotForm(m) ? `${m.content_text!.trim()} ${FORM_SENT_NOTE}` : m.content_text!.trim(),
    }))
}
