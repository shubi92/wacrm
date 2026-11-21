import Image from 'next/image'
import { MOVING_BRAND, MOVING_TEXT } from '@/lib/whatsapp/forms/furniture-moving'

/** An unknown, altered or expired link. Says so in both languages: a
 *  link we can't read doesn't tell us which one the customer uses. */
export function Gone() {
  return (
    <div className="shell" dir="rtl" lang="ar">
      <header className="top">
        <div className="top-row">
          <div className="mark">
            <Image src={MOVING_BRAND.logo} alt="" width={92} height={72} />
          </div>
          <div className="brand">
            <b>{MOVING_BRAND.name.ar}</b>
            <span lang="en">{MOVING_BRAND.name.en}</span>
          </div>
        </div>
      </header>
      <main className="body gone">
        <div className="done">
          <h1>{MOVING_TEXT.invalidTitle.ar}</h1>
          <p>{MOVING_TEXT.invalidText.ar}</p>
        </div>
        <div className="done" dir="ltr" lang="en">
          <h1>{MOVING_TEXT.invalidTitle.en}</h1>
          <p>{MOVING_TEXT.invalidText.en}</p>
        </div>
        <div className="actions">
          <a className="btn primary" href={MOVING_BRAND.whatsapp}>
            {MOVING_TEXT.toWhatsApp.ar}
          </a>
        </div>
      </main>
    </div>
  )
}
