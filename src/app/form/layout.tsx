// ============================================================
// /form/[token] — a form a customer opens from a button in the
// WhatsApp chat. Public: no sign-in, on a phone, usually in Arabic.
//
// It has its own look (the business's, not this app's) and its own
// light/dark, following the phone rather than the app's saved theme.
//
// Referrer-Policy: no-referrer — the one-time token is in the address,
// and must not travel in a `Referer` header to anything the page loads
// or links to (the same guard as /join/[token]).
// ============================================================

import type { Metadata, Viewport } from 'next'
import type { ReactNode } from 'react'
import { IBM_Plex_Sans_Arabic } from 'next/font/google'
import './form.css'

const plex = IBM_Plex_Sans_Arabic({
  subsets: ['arabic', 'latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-form',
})

export const metadata: Metadata = {
  title: { absolute: 'طلب نقل عفش' },
  referrer: 'no-referrer',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#f3f4f4' },
    { media: '(prefers-color-scheme: dark)', color: '#0f1111' },
  ],
  colorScheme: 'light dark',
  viewportFit: 'cover',
}

export default function FormLayout({ children }: { children: ReactNode }) {
  return <div className={`mf ${plex.variable}`}>{children}</div>
}
