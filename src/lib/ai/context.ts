import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'
import { FORM_SENT_NOTE } from '@/lib/whatsapp/forms'
import { isMenuReplyId, menuOfRowId, menuSentNote } from '@/lib/whatsapp/menus'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
  ai_generated?: boolean | null
  interactive_reply_id?: string | null
  interactive_payload?: { kind?: string; sections?: { rows?: { id?: string }[] }[] } | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Other non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
 *
 * Two kinds of interactive message do count. A customer's tap on one
 * of the bot's menus: its text is the option they chose. And the bot's
 * own line that went out with a form's button or a menu: without it
 * the bot can't see that it already sent one, and sends it again. It
 * is marked so the bot can tell it from a plain line.
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
    .select('sender_type, content_type, content_text, ai_generated, interactive_reply_id, interactive_payload')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio', 'interactive'])
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  // The interactive messages the auto-reply bot itself sends: a line
  // with a form's button, or (stored as a list) a line with a menu.
  const isBotSend = (m: DbMessage) =>
    m.content_type === 'interactive' && m.sender_type === 'bot' && m.ai_generated === true
  const sentNote = (m: DbMessage) => {
    // Which menu it was is in the ids of the rows it was sent with.
    const menu = menuOfRowId(m.interactive_payload?.sections?.[0]?.rows?.[0]?.id)
    return menu ? menuSentNote(menu) : FORM_SENT_NOTE
  }
  // The customer's tap on one of the bot's menus. Taps on a Flow's or an
  // automation's buttons are not part of the bot's conversation.
  const isMenuTap = (m: DbMessage) =>
    m.content_type === 'interactive' && m.sender_type === 'customer' && isMenuReplyId(m.interactive_reply_id)
  return rows
    .filter(
      (m) =>
        m.content_type === 'text' ||
        (m.content_type === 'audio' && m.sender_type === 'customer') ||
        isBotSend(m) ||
        isMenuTap(m),
    )
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: isBotSend(m) ? `${m.content_text!.trim()} ${sentNote(m)}` : m.content_text!.trim(),
    }))
}
