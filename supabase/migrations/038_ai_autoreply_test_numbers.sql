-- ============================================================
-- 038_ai_autoreply_test_numbers
--
-- Optional allow-list for the auto-reply bot while an account tests it
-- on real WhatsApp. When the array has entries, the bot only answers
-- contacts whose phone matches one of them; everyone else is left to
-- the team exactly as if auto-reply were off. NULL or empty = the bot
-- answers everyone (the normal, live behaviour).
--
-- Idempotent — safe to run multiple times.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS auto_reply_test_numbers text[];
