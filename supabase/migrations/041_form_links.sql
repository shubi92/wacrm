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
-- `submitted_at` is what makes a link single-use: the submit path
-- claims it with one UPDATE ... WHERE submitted_at IS NULL.
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
