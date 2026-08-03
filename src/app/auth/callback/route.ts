import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Exchanges the one-time `code` on an emailed auth link for a real session
// cookie, then forwards the user on. Every Supabase email link — password
// recovery, magic link, email confirmation — lands here first.
//
// Without this route the PKCE flow has nowhere to complete: the code never
// becomes a session, the user is bounced to /login, and password reset is
// silently impossible. `forgot-password/page.tsx` has always pointed at this
// path; it just didn't exist.
export async function GET(request: Request) {
  const { searchParams, origin: requestOrigin } = new URL(request.url)
  const code = searchParams.get('code')

  // Behind a reverse proxy (Hostinger, most managed Node hosts) `request.url`
  // carries the container's internal bind address — redirecting to it sends
  // the user to a dead https://0.0.0.0:3000. Prefer the configured public
  // origin. NEXT_PUBLIC_SITE_URL is trusted config, not a request header, so
  // this can't be poisoned by a spoofed Host.
  const origin = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, '') || requestOrigin

  // Only allow same-origin relative paths — an attacker-supplied absolute URL
  // here would turn the login flow into an open redirect.
  const nextParam = searchParams.get('next') ?? '/dashboard'
  const next =
    nextParam.startsWith('/') && !nextParam.startsWith('//')
      ? nextParam
      : '/dashboard'

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)

  if (error) {
    // Expired or already-used link — both are common and neither is worth
    // leaking detail about.
    return NextResponse.redirect(`${origin}/login?error=invalid_link`)
  }

  return NextResponse.redirect(`${origin}${next}`)
}
