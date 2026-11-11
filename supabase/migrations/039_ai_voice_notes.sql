-- ============================================================
-- 039_ai_voice_notes
--
-- Voice-note support for the auto-reply bot.
--   Listening: a customer's voice note is turned into text with Google
--   Gemini (the account's own key) and answered like a typed message.
--   The text is stored in the existing messages.content_text column of
--   the audio message — no messages change here.
--   Speaking: the bot's answer can also be spoken with ElevenLabs (the
--   account's own key + a chosen voice) and sent as a voice note.
--
-- Both switches default to off; both keys are stored
-- AES-256-GCM-encrypted, like ai_configs.api_key. Existing ai_configs
-- RLS policies cover the new columns.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS voice_transcription_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS voice_reply_enabled         boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS gemini_api_key              text,   -- AES-256-GCM-encrypted
  ADD COLUMN IF NOT EXISTS elevenlabs_api_key          text,   -- AES-256-GCM-encrypted
  ADD COLUMN IF NOT EXISTS elevenlabs_voice_id         text;
