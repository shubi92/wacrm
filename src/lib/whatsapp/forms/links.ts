// ============================================================
// The link behind a form's "Open form" button.
//
// The address holds nothing but a random token: no phone number, name
// or chat id. Which chat, form and language it stands for is looked up
// here, on the server, in `form_links` (migration 041), where only the
// token's hash is kept. A link works for seven days and for one
// submission.
// ============================================================

import crypto from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { FormLang } from './furniture-moving'

/** How long a link can be opened and sent. */
export const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 32 random bytes, base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/
export const isToken = (token: string): boolean => TOKEN.test(token)

export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex')

export interface FormLink {
  id: string
  account_id: string
  conversation_id: string
  contact_id: string
  form: string
  lang: FormLang
  expires_at: string
  submitted_at: string | null
  answers: Record<string, unknown> | null
}
const COLUMNS =
  'id, account_id, conversation_id, contact_id, form, lang, expires_at, submitted_at, answers'

/**
 * Make a link for one chat and return its address. Throws when it
 * can't (the caller hands the chat to a person instead).
 */
export async function createFormLink(
  db: SupabaseClient,
  args: { accountId: string; conversationId: string; contactId: string; form: string; lang: FormLang },
): Promise<string> {
  // The bot runs from Meta's webhook, with no browser request to take
  // the site's address from.
  const site = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/+$/, '')
  if (!site) throw new Error('NEXT_PUBLIC_SITE_URL is not set, so the form has no address')

  const token = crypto.randomBytes(32).toString('base64url')
  const { error } = await db.from('form_links').insert({
    token_hash: hashToken(token),
    account_id: args.accountId,
    conversation_id: args.conversationId,
    contact_id: args.contactId,
    form: args.form,
    lang: args.lang,
    expires_at: new Date(Date.now() + LINK_TTL_MS).toISOString(),
  })
  if (error) throw new Error(`the form link could not be saved: ${error.message}`)
  return `${site}/form/${token}`
}

export type FormLinkState =
  | { status: 'open'; link: FormLink }
  /** Already sent: `link.answers` holds what the customer sent. */
  | { status: 'submitted'; link: FormLink }
  /** Unknown, altered or expired. */
  | { status: 'invalid' }

/** What a token stands for right now. Throws only if the database does. */
export async function findFormLink(db: SupabaseClient, token: string): Promise<FormLinkState> {
  if (!isToken(token)) return { status: 'invalid' }
  const { data, error } = await db
    .from('form_links')
    .select(COLUMNS)
    .eq('token_hash', hashToken(token))
    .maybeSingle()
  if (error) throw new Error(`form link lookup failed: ${error.message}`)
  const link = data as FormLink | null
  if (!link) return { status: 'invalid' }
  if (link.submitted_at) return { status: 'submitted', link }
  if (Date.parse(link.expires_at) <= Date.now()) return { status: 'invalid' }
  return { status: 'open', link }
}
