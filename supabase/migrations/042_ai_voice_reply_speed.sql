-- ============================================================
-- 042_ai_voice_reply_speed
--
-- How fast the auto-reply bot speaks in a voice reply, per account.
-- Until now this was one number in the code (0.9) for everyone; the
-- default keeps every existing account sounding exactly as it does.
--
-- 0.7 to 1.2 is the range ElevenLabs accepts (1.0 = the voice's own
-- pace). The app brings a value inside the range before saving; the
-- check is the backstop.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS voice_reply_speed numeric(3,2) NOT NULL DEFAULT 0.9
    CHECK (voice_reply_speed >= 0.7 AND voice_reply_speed <= 1.2);
