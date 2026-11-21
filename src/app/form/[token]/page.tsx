import { supabaseAdmin } from '@/lib/ai/admin-client'
import { MOVING_FORM } from '@/lib/whatsapp/forms/furniture-moving'
import { findFormLink } from '@/lib/whatsapp/forms/links'
import { Gone } from './gone'
import { MovingForm } from './moving-form'

// What a token stands for changes (it is used up, it expires), so the
// page is built on every request and never from a cache.
export const dynamic = 'force-dynamic'

export default async function FormPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const state = await findFormLink(supabaseAdmin(), token)
  // The moving form is the only one with a page today.
  if (state.status === 'invalid' || state.link.form !== MOVING_FORM) return <Gone />
  return (
    <MovingForm
      token={token}
      lang={state.link.lang}
      // Opened again after sending: show what was received, not a blank form.
      sent={state.status === 'submitted' ? (state.link.answers ?? {}) : null}
    />
  )
}
