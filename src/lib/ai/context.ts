import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChatMessage } from './types'
import { aiContextMessageLimit } from './defaults'

interface DbMessage {
  sender_type: 'customer' | 'agent' | 'bot'
  content_type: string
  content_text: string | null
}

/**
 * Fetch the last N text messages of a conversation and map them to the
 * provider-neutral chat shape. Customer messages become `user`; agent
 * and bot messages become `assistant`. Other non-text messages (media,
 * templates, interactive) are excluded — they carry no text to model.
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
    .select('sender_type, content_type, content_text')
    .eq('conversation_id', conversationId)
    .in('content_type', ['text', 'audio'])
    .not('content_text', 'is', null)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw error

  const rows = ((data ?? []) as DbMessage[]).reverse()
  return rows
    .filter((m) => m.content_type === 'text' || m.sender_type === 'customer')
    .filter((m) => m.content_text && m.content_text.trim())
    .map((m) => ({
      role: m.sender_type === 'customer' ? 'user' : 'assistant',
      content: m.content_text!.trim(),
    }))
}
