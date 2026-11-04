-- ============================================================
-- 037_ai_resumed_at
--
-- When "Resume AI" was last clicked on a conversation.
--
-- The auto-reply bot stays quiet on a thread where a teammate, a Flow
-- or the public API sent a message in the last 24h. Without this
-- column, a teammate who replied and then clicked "Resume AI" would
-- keep the bot muted by their own earlier reply for up to a day. The
-- bot now only counts outbound messages sent after this timestamp.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS ai_resumed_at timestamptz;
