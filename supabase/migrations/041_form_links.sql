-- ============================================================
-- 041_form_links
--
-- One row per form link the AI agent sends in a WhatsApp chat (see
-- src/lib/whatsapp/forms). The customer opens /form/<token>; the row
-- says which chat, form and language that token stands for, when it
-- stops working, and — once the form is sent — the answers.
--
-- Only the token's SHA-256 is stored, so reading this table (or a
-- backup of it) does not hand anyone a working link.
--
-- `submitted_at` is what makes a link single-use. `submit_form_link`
-- claims the link and stores the answers as a message in the chat in
-- one transaction: a link is never marked as sent without its message,
-- and a double tap can never make two.
--
-- Idempotent — safe to run multiple times.
-- ============================================================
CREATE TABLE IF NOT EXISTS form_links (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash TEXT NOT NULL UNIQUE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  form TEXT NOT NULL,
  lang TEXT NOT NULL CHECK (lang IN ('ar', 'en')),
  expires_at TIMESTAMPTZ NOT NULL,
  submitted_at TIMESTAMPTZ,
  answers JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_form_links_conversation ON form_links(conversation_id);

-- No policies on purpose: the table is read and written only by the
-- service role (the bot's send path and the public form endpoints,
-- which look a row up by its token). Signed-in users never touch it;
-- the answers reach them as a message in the chat.
ALTER TABLE form_links ENABLE ROW LEVEL SECURITY;

-- Use a link up and put the answers in its chat, together or not at
-- all. Returns false when the link was already sent or has run out.
CREATE OR REPLACE FUNCTION submit_form_link(p_id UUID, p_answers JSONB, p_text TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  conv UUID;
BEGIN
  UPDATE form_links
     SET submitted_at = NOW(), answers = p_answers
   WHERE id = p_id AND submitted_at IS NULL AND expires_at > NOW()
  RETURNING conversation_id INTO conv;
  IF conv IS NULL THEN
    RETURN FALSE;
  END IF;
  INSERT INTO messages (conversation_id, sender_type, content_type, content_text, message_id, status)
  -- Not a WhatsApp message id: the answers came through our own page.
  VALUES (conv, 'customer', 'text', p_text, 'form:' || p_id::text, 'delivered');
  RETURN TRUE;
END;
$$;

-- Only the server calls it. Without the explicit grant the call fails
-- for the service role (see 031).
REVOKE ALL ON FUNCTION submit_form_link(UUID, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_form_link(UUID, JSONB, TEXT) TO service_role;
