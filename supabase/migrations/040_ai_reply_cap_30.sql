-- ============================================================
-- 040_ai_reply_cap_30
--
-- "Max auto-replies per conversation" may now go up to 30 (was 20).
--
-- Migration 029 wrote the 1..20 range as an unnamed column CHECK, so
-- its name is whatever Postgres generated. Rather than guess it, drop
-- every CHECK on ai_configs that covers only this column, then add the
-- new range under a fixed name.
--
-- Apply BEFORE deploying the app change: the app lets an admin save up
-- to 30, and the old constraint would refuse it. Harmless on its own —
-- it only widens what is accepted; no row is changed.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att
      ON att.attrelid = con.conrelid AND att.attnum = con.conkey[1]
    WHERE con.conrelid = 'public.ai_configs'::regclass
      AND con.contype = 'c'
      AND array_length(con.conkey, 1) = 1
      AND att.attname = 'auto_reply_max_per_conversation'
  LOOP
    EXECUTE format('ALTER TABLE public.ai_configs DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.ai_configs
  ADD CONSTRAINT ai_configs_auto_reply_max_per_conversation_check
  CHECK (auto_reply_max_per_conversation BETWEEN 1 AND 30);
