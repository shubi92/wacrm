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

const UNIT = String.raw`(?: ?(?:[%٪]|[mم][²2]))`
/** One side of a range: a number with its optional "+", decimals and unit. */
const SIDE = String.raw`\+?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?${UNIT}?`

// One pass, first alternative wins. Digits glued to Latin letters
// ("A4", "5mm") are left alone.
const NUMBER = new RegExp(
  [
    // 1 phone shape → digit by digit: starts with "+" or "0" (spaces or
    //   dashes allowed inside, 7+ digits), or 9+ digits with no separator
    String.raw`(?<![\dA-Za-z])(\+\d(?:[ -]?\d){6,}|0\d(?:[ -]?\d){5,}|\d{9,})(?![\dA-Za-z])`,
    // 2 date "2026-11-25" / "25/11/2026" → left exactly as written
    String.raw`(?<![\dA-Za-z])(\d{1,4}[-/]\d{1,2}[-/]\d{1,4})(?![\dA-Za-z])`,
    // 3-4 range "200–375", "300 - 450" → "<first> إلى <second>"
    String.raw`(?<![\dA-Za-z.,+])(${SIDE}) ?[-–—] ?(${SIDE})(?![\dA-Za-z])`,
    // 5-6 clock time "7:30"
    String.raw`(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])`,
    // 7-10 number: optional "+", whole part (with or without a thousands
    //   comma), optional decimals, optional "%" or "m²"/"m2" right after
    String.raw`(?<![\dA-Za-z.,+])(\+)?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(${UNIT})?(?![\dA-Za-z])`,
  ].join('|'),
  'g',
)

/** Spell out every number in `text` (no list folding). */
const speakAll = (text: string) => text.replace(NUMBER, speakNumber)

function speakNumber(
  match: string,
  phone?: string,
  date?: string,
  from?: string,
  to?: string,
  hh?: string,
  mm?: string,
  plus?: string,
  whole?: string,
  dec?: string,
  unit?: string,
): string {
  if (phone) return digitByDigit(phone)
  if (date) return match
  if (from && to) return `${speakAll(from)} إلى ${speakAll(to)}`

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
  return speakAll(joinListLines(text).replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660)))
}

/** Words the voice misreads without vowel marks, spelled exactly as it
 *  should be given them. One line per word. */
const MARKED_WORDS = [
  'أَبشِر', // "sure, right away", to a man
  'أَبشِري', // same, to a woman
]

const MARKS = String.raw`[\u064B-\u065F\u0670]`
/** Standalone word, with or without marks, on a hamza or a plain alef. */
const MARKED_WORD_PATTERNS = MARKED_WORDS.map((spoken) => {
  const letters = [...spoken.replace(new RegExp(MARKS, 'g'), '')]
  const body = letters.map((c) => (/[اأ]/.test(c) ? '[اأ]' : c) + `${MARKS}*`).join('')
  return { spoken, pattern: new RegExp(`(?<!\\p{L}|${MARKS})${body}(?!\\p{L}|${MARKS})`, 'gu') }
})

/** Arabic reply text → the same text with `MARKED_WORDS` vowel-marked. */
export function markSpokenWords(text: string): string {
  return MARKED_WORD_PATTERNS.reduce((out, w) => out.replace(w.pattern, w.spoken), text)
}
