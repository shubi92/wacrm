// ============================================================
// POST /api/v1/conversations/{id}/ai-pause — stop the AI agent on one
// conversation (scope: messages:send). For a connected system whose
// own staff take a chat over (e.g. a CRM's "Take this chat").
//
// Sets the same pause the bot's own handoff and the inbox's "Take
// over" set, so the inbox shows the chat as paused and "Resume AI"
// undoes it. Sends the customer nothing and fires no webhook.
// Idempotent. Account-scoped: a foreign id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { API_PAUSE_NOTE, isReplyCapSummary } from '@/lib/ai/handoff';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // A key that may speak on a conversation may silence the bot on it:
    // sending a message already keeps the bot quiet for a day.
    const ctx = await requireApiKey(request, 'messages:send');
    const { id } = await params;

    const { data: conv, error } = await ctx.supabase
      .from('conversations')
      .select('id, ai_autoreply_disabled, ai_handoff_summary')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/conversations/ai-pause] read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    // A pause someone already set keeps its own note (it may carry the
    // lead the bot collected). The reply cap's pause is the exception:
    // the bot lifts that one by itself after a quiet day, so it is
    // replaced by this one, which only "Resume AI" lifts.
    const alreadyPaused = conv.ai_autoreply_disabled === true;
    if (!alreadyPaused || isReplyCapSummary(conv.ai_handoff_summary)) {
      const { error: upErr } = await ctx.supabase
        .from('conversations')
        .update({
          ai_autoreply_disabled: true,
          ai_handoff_summary: API_PAUSE_NOTE,
        })
        .eq('id', id)
        .eq('account_id', ctx.accountId);
      if (upErr) {
        console.error('[api/v1/conversations/ai-pause] update error:', upErr);
        return fail('internal', 'Failed to pause the AI agent', 500);
      }
    }

    return ok({ id, ai_paused: true, already_paused: alreadyPaused });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
