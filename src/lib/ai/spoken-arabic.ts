// ============================================================
// Numbers written out as Arabic words, for the bot's VOICE replies
// only — the text reply keeps its digits. ElevenLabs reads bare digits
// inside an Arabic sentence badly ("345 ريال" comes out mumbled), so we
// hand it words instead. Everyday neutral forms, no gender agreement.
// Anything not confidently convertible is left exactly as written.
// ============================================================

const ONES = [
  'صفر', 'واحد', 'اثنين', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر',
  'ثمانية عشر', 'تسعة عشر',
]
const TENS = ['', '', 'عشرين', 'ثلاثين', 'أربعين', 'خمسين', 'ستين', 'سبعين', 'ثمانين', 'تسعين']
const HUNDREDS = [
  '', 'مئة', 'مئتين', 'ثلاثمئة', 'أربعمئة', 'خمسمئة', 'ستمئة', 'سبعمئة', 'ثمانمئة', 'تسعمئة',
]

function under1000(n: number): string {
  const parts: string[] = []
  if (n >= 100) parts.push(HUNDREDS[Math.floor(n / 100)])
  const r = n % 100
  if (r >= 20) parts.push(r % 10 ? `${ONES[r % 10]} و${TENS[Math.floor(r / 10)]}` : TENS[r / 10])
  else if (r > 0) parts.push(ONES[r])
  return parts.join(' و')
}

/** 0–999,999 as words: 345 → "ثلاثمئة وخمسة وأربعين", 1150 → "ألف ومئة وخمسين". */
export function arabicNumberWords(n: number): string {
  if (n === 0) return ONES[0]
  const t = Math.floor(n / 1000)
  const parts: string[] = []
  if (t === 1) parts.push('ألف')
  else if (t === 2) parts.push('ألفين')
  else if (t >= 3 && t <= 10) parts.push(`${ONES[t]} آلاف`)
  else if (t > 10) parts.push(`${under1000(t)} ألف`)
  if (n % 1000) parts.push(under1000(n % 1000))
  return parts.join(' و')
}

const digitByDigit = (s: string) =>
  [...s.replace(/[ -]/g, '')].map((c) => (c === '+' ? 'زائد' : ONES[Number(c)])).join(' ')

/** "1. " / "2) " / "١- " at the start of a line. */
const LIST_MARKER = /^[ \t]*[0-9٠-٩]{1,2}[.)-][ \t]+/

/** Fold numbered-list lines into one sentence with a comma pause, so the
 *  "1", "2", "3" markers aren't read aloud mid-sentence. */
function joinListLines(text: string): string {
  return text.split('\n').reduce((out, line) => {
    const item = line.replace(LIST_MARKER, '')
    if (item === line) return `${out}\n${line}`
    const pause = !out.trim() || /[:،,.؟?!؛;]\s*$/.test(out) ? ' ' : '، '
    return out.trimEnd() + pause + item
  }, '')
}

// One pass, first alternative wins:
//   1   phone / long run, 7+ digits ("+966 50 123 4567") → digit by digit
//   2-3 clock time "7:30"
//   4-7 number: optional "+", whole part (with or without a thousands
//       comma), optional decimals, optional "%" or "m²" right after.
// Digits glued to Latin letters ("A4", "5mm") are left alone.
const NUMBER =
  /(?<![\dA-Za-z])(\+?\d(?:[ -]?\d){6,})(?![\dA-Za-z])|(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])|(?<![\dA-Za-z.,+])(\+)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?( ?[%٪]| ?[mم]²)?(?![\dA-Za-z])/g

function speakNumber(
  match: string,
  phone?: string,
  hh?: string,
  mm?: string,
  plus?: string,
  whole?: string,
  dec?: string,
  unit?: string,
): string {
  if (phone) return digitByDigit(phone)

  if (hh) {
    const h = Number(hh)
    const m = Number(mm)
    if (h > 24 || m > 59) return match
    if (m === 0) return arabicNumberWords(h)
    if (m === 30) return `${arabicNumberWords(h)} ونص`
    return `${arabicNumberWords(h)} و${arabicNumberWords(m)} دقيقة`
  }

  if (!whole || /^0\d/.test(whole)) return match
  const n = Number(whole.replace(/,/g, ''))
  if (n > 999_999) return match

  let words = arabicNumberWords(n)
  const fraction = dec?.replace(/0+$/, '')
  if (fraction === '5') words += ' ونص'
  else if (fraction) words += ` فاصلة ${digitByDigit(fraction)}`
  if (plus) words = `زائد ${words}`
  if (unit) words += /[%٪]/.test(unit) ? ' بالمئة' : ' متر مربع'
  return words
}

/** Arabic reply text → the same text with list markers folded and
 *  numbers spelled out. Leaves whitespace for the caller to collapse. */
export function speakArabicNumbers(text: string): string {
  return joinListLines(text)
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(NUMBER, speakNumber)
}
