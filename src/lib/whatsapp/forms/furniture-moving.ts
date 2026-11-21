// ============================================================
// The furniture-moving form: a web page of our own, opened from a link
// button in the WhatsApp chat (see ./links and /form/[token]).
//
// One definition feeds everything:
//   - `MOVING_SCREENS`         → what the page draws, step by step;
//   - `validateMovingAnswers`  → the server's check of what the page
//     sent (a public endpoint: nothing the browser says is trusted);
//   - `readMovingAnswers`      → the answers as the rows the sales rep
//     reads in the inbox and the lead, and the customer's own summary.
//
// The questions are the ones the owner approved. No prices anywhere.
// No server-only imports here: the page's client component uses it too.
// ============================================================

export type FormLang = 'en' | 'ar'
export type L = Record<FormLang, string>
const L = (en: string, ar: string): L => ({ en, ar })

export interface Option {
  id: string
  label: L
  /** A shorter label where the page has little room (floor buttons). */
  short?: L
  /** A second line under the label (the two "where is the move" cards). */
  hint?: L
}
const opt = (id: string, en: string, ar: string, extra: Partial<Option> = {}): Option => ({
  id,
  label: L(en, ar),
  ...extra,
})

export const MOVING_FORM = 'furniture_moving'

/** Only AlSafrrat uses forms today, so its look and number are plain
 *  constants beside the form rather than per-account settings.
 *  ponytail: move to the account when a second business sends a form. */
export const MOVING_BRAND = {
  name: L('Al-Safrrat', 'الصفرات'),
  form: L('Furniture moving request', 'طلب نقل عفش'),
  logo: '/brand/alsafrrat-emblem.png',
  /** The business's WhatsApp number, for "Back to WhatsApp". */
  whatsapp: 'https://wa.me/966534028374',
}

const CITIES = [
  opt('riyadh', 'Riyadh', 'الرياض'),
  opt('kharj', 'Al Kharj', 'الخرج'),
  opt('jeddah', 'Jeddah', 'جدة'),
  opt('dammam', 'Dammam', 'الدمام'),
  opt('other', 'Another city', 'مدينة أخرى'),
]
const FLOORS = [
  opt('ground', 'Ground floor', 'الدور الأرضي', { short: L('Ground', 'أرضي') }),
  opt('1', '1st floor', 'الدور الأول', { short: L('1', '1') }),
  opt('2', '2nd floor', 'الدور الثاني', { short: L('2', '2') }),
  opt('3', '3rd floor', 'الدور الثالث', { short: L('3', '3') }),
  opt('4_plus', '4th floor or higher', 'الدور الرابع أو أعلى', { short: L('4+', '4+') }),
]
export const YES_NO = [opt('yes', 'Yes', 'نعم'), opt('no', 'No', 'لا')]
const CALL_TIMES = [
  opt('morning', 'Morning', 'الصباح'),
  opt('afternoon', 'Afternoon', 'بعد الظهر'),
  opt('evening', 'Evening', 'المساء'),
]
const MOVE_TYPES = [
  opt('within', 'Inside one city', 'داخل نفس المدينة', {
    hint: L('From one district to another', 'من حي إلى حي'),
  }),
  opt('between', 'Between two cities', 'بين مدينتين', {
    hint: L('From one city to another', 'من مدينة إلى مدينة'),
  }),
]

/** Things counted with + and −. `id` is the answer's field name; 0
 *  means the customer does not have it. */
const BEDROOMS = [
  opt('qty_master', 'Master bedroom', 'غرفة نوم رئيسية'),
  opt('qty_kids_beds', "Kids' beds", 'أسرّة أطفال'),
  opt('qty_wardrobes', 'Wardrobes', 'دواليب'),
]
const LIVING = [
  opt('qty_sofas', 'Sofa pieces', 'قطع كنب'),
  opt('qty_majlis', 'Floor majlis', 'مجلس أرضي'),
  opt('qty_carpets', 'Carpets', 'سجاد'),
  opt('qty_dining', 'Dining table with buffet', 'سفرة طعام مع بوفيه'),
  opt('qty_chairs', 'Dining chairs', 'كراسي السفرة'),
  opt('qty_side_tables', 'Side tables', 'طاولات خدمة'),
]
const OTHER_FURNITURE = [
  opt('qty_screens', 'Screens', 'شاشات'),
  opt('qty_bookcase', 'Bookcase', 'مكتبة'),
  opt('qty_desk', 'Desk', 'مكتب'),
  opt('qty_sports', 'Sports equipment', 'أجهزة رياضية'),
]
const APPLIANCES = [
  opt('qty_fridge', 'Fridge', 'ثلاجة'),
  opt('qty_oven', 'Oven', 'فرن'),
  opt('qty_freezer', 'Freezer', 'فريزر'),
  opt('qty_washer', 'Washing machine', 'غسالة'),
  opt('qty_dryer', 'Dryer', 'مجفف'),
  opt('qty_dishwasher', 'Dishwasher', 'غسالة صحون'),
]
const ACS = [
  opt('ac_split', 'Split units', 'مكيفات سبليت'),
  opt('ac_window', 'Window units', 'مكيفات شباك'),
]
const CURTAINS = [
  opt('curtains_roller', 'Roller curtains', 'ستائر رول'),
  opt('curtains_fabric', 'Fabric curtains', 'ستائر قماش'),
]
const FURNITURE = [...BEDROOMS, ...LIVING, ...OTHER_FURNITURE]
/** Every counted field. */
const COUNTS = [...FURNITURE, ...APPLIANCES, ...ACS, ...CURTAINS]

/** Most of any one thing. */
export const MAX_COUNT = 20
/** Longest free text we accept and pass on (the lead contract's limit). */
export const MAX_TEXT = 300

// ------------------------------------------------------------
// What the page draws
// ------------------------------------------------------------

/** When a field shows: by the kind of move, or once an AC is added. */
export type When = 'within' | 'between' | 'acs'

export type Field =
  | { t: 'cards'; id: string; label: L; options: Option[] }
  | { t: 'select'; id: string; label: L; options: Option[]; when?: When }
  | { t: 'text'; id: string; label: L; placeholder?: L }
  | { t: 'chips'; id: string; label: L; options: Option[]; optional?: boolean }
  | { t: 'date'; id: string; label: L }
  | { t: 'area'; id: string; label: L; placeholder?: L }
  | { t: 'yesno'; id: string; label: L; when?: When }
  | { t: 'section'; title: L; fields: Field[] }
  | { t: 'group'; title: L; items: Option[]; after?: Extract<Field, { t: 'yesno' }> }

export interface Screen {
  title: L
  help?: L
  /** Shows the running "items chosen" count in the footer. */
  counted?: boolean
  fields: Field[]
}

export const MOVING_SCREENS: Screen[] = [
  {
    title: L('Where are you moving?', 'من أين وإلى أين؟'),
    fields: [
      { t: 'cards', id: 'move_type', label: L('Where is the move?', 'أين النقل؟'), options: MOVE_TYPES },
      { t: 'select', id: 'city', label: L('City', 'المدينة'), options: CITIES, when: 'within' },
      {
        t: 'section',
        title: L('Moving from', 'النقل من'),
        fields: [
          { t: 'select', id: 'from_city', label: L('City', 'المدينة'), options: CITIES, when: 'between' },
          { t: 'text', id: 'from_district', label: L('District', 'الحي'), placeholder: L('e.g. Al Malqa', 'مثال: الملقا') },
          { t: 'chips', id: 'from_floor', label: L('Which floor?', 'في أي دور؟'), options: FLOORS },
        ],
      },
      {
        t: 'section',
        title: L('Moving to', 'النقل إلى'),
        fields: [
          { t: 'select', id: 'to_city', label: L('City', 'المدينة'), options: CITIES, when: 'between' },
          { t: 'text', id: 'to_district', label: L('District', 'الحي'), placeholder: L('e.g. Al Yasmin', 'مثال: الياسمين') },
          { t: 'chips', id: 'to_floor', label: L('Which floor?', 'في أي دور؟'), options: FLOORS },
        ],
      },
      { t: 'date', id: 'move_date', label: L('Moving date', 'تاريخ النقل') },
    ],
  },
  {
    title: L('Your furniture', 'الأثاث'),
    help: L('Tap + for each piece you have.', 'اضغط + لكل قطعة عندك.'),
    counted: true,
    fields: [
      { t: 'group', title: L('Bedrooms', 'غرف النوم'), items: BEDROOMS },
      { t: 'group', title: L('Living areas', 'المجالس والمعيشة'), items: LIVING },
      { t: 'group', title: L('Other items', 'قطع أخرى'), items: OTHER_FURNITURE },
      {
        t: 'area',
        id: 'other_items',
        label: L('Anything not in the list?', 'عندك قطع غير موجودة في القائمة؟'),
        placeholder: L('Write it here', 'اكتبها هنا'),
      },
    ],
  },
  {
    title: L('Kitchen and fittings', 'المطبخ والتجهيزات'),
    help: L('Appliances, kitchen, air conditioners and curtains.', 'الأجهزة والمطبخ والمكيفات والستائر.'),
    counted: true,
    fields: [
      { t: 'group', title: L('Appliances', 'الأجهزة'), items: APPLIANCES },
      {
        t: 'section',
        title: L('Kitchen', 'المطبخ'),
        fields: [
          { t: 'yesno', id: 'cabinets', label: L('Kitchen cabinets to move?', 'هل يوجد خزائن مطبخ للنقل؟') },
          {
            t: 'yesno',
            id: 'pack_kitchen',
            label: L(
              'Should we wrap and pack your kitchenware (plates, cups, pots)?',
              'هل تريد أن نغلّف ونعبّئ أواني المطبخ (صحون، أكواب، قدور)؟',
            ),
          },
        ],
      },
      {
        t: 'group',
        title: L('Air conditioners', 'المكيفات'),
        items: ACS,
        after: {
          t: 'yesno',
          id: 'ac_install',
          label: L('Install the ACs at the new home?', 'تركيب المكيفات في المنزل الجديد؟'),
          when: 'acs',
        },
      },
      { t: 'group', title: L('Curtains', 'الستائر'), items: CURTAINS },
    ],
  },
  {
    title: L('How do we reach you?', 'كيف نتواصل معك؟'),
    help: L('Last step.', 'آخر خطوة.'),
    fields: [
      { t: 'text', id: 'name', label: L('Your name', 'الاسم') },
      { t: 'chips', id: 'call_time', label: L('Best time to call you', 'أفضل وقت للاتصال بك'), options: CALL_TIMES, optional: true },
      { t: 'area', id: 'notes', label: L('Anything else we should know?', 'ملاحظات أخرى') },
    ],
  },
]

/** The page's wording outside the questions. */
export const MOVING_TEXT = {
  otherLang: L('عربي', 'English'),
  step: L('Step {n} of 4', 'الخطوة {n} من 4'),
  next: L('Continue', 'متابعة'),
  back: L('Back', 'رجوع'),
  send: L('Send request', 'إرسال الطلب'),
  sending: L('Sending…', 'جارٍ الإرسال…'),
  optional: L('optional', 'اختياري'),
  count: L('Items chosen: ', 'القطع المختارة: '),
  more: L('Add one: ', 'زيادة: '),
  less: L('Remove one: ', 'تقليل: '),
  doneTitle: L('We got your request', 'وصلنا طلبك'),
  doneText: L(
    'Our sales team will contact you shortly on WhatsApp.',
    'يتواصل معك فريق المبيعات قريباً على واتساب.',
  ),
  summary: L('Your request', 'ملخص طلبك'),
  toWhatsApp: L('Back to WhatsApp', 'العودة إلى واتساب'),
  failed: L(
    'We could not send your request. Check your connection and try again.',
    'تعذّر إرسال طلبك. تحقق من الاتصال وحاول مرة أخرى.',
  ),
  invalidTitle: L('This link is no longer valid', 'هذا الرابط لم يعد صالحاً'),
  invalidText: L('Please message us on WhatsApp.', 'راسلنا على واتساب من فضلك.'),
}

/** Why an answer was turned down — the same words on the page and from
 *  the server. */
export type FieldError = 'required' | 'choose' | 'invalid' | 'too_long' | 'past'
export const FIELD_ERRORS: Record<FieldError, L> = {
  required: L('Please fill this in.', 'هذا الحقل مطلوب.'),
  choose: L('Please choose one.', 'اختر واحداً من فضلك.'),
  invalid: L('This answer is not valid.', 'هذه الإجابة غير صحيحة.'),
  too_long: L('This is too long.', 'النص طويل جداً.'),
  past: L('Choose today or a later date.', 'اختر تاريخ اليوم أو بعده.'),
}

// ------------------------------------------------------------
// The answers
// ------------------------------------------------------------

/** The answers as the page holds them and the server stores them:
 *  option ids, whole numbers, and the customer's own text. */
export type MovingValues = Record<string, string | number | undefined>

/** What the page starts with. Floors, districts, date and name have no
 *  default: the customer must give them. */
export const MOVING_DEFAULTS: MovingValues = {
  move_type: 'within',
  city: 'riyadh',
  from_city: 'riyadh',
  to_city: 'jeddah',
  cabinets: 'no',
  pack_kitchen: 'no',
  ac_install: 'yes',
}

const count = (a: Record<string, unknown>, key: string): number => {
  const v = a[key]
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

/** Whether a field with a `when` shows for these answers. */
export function shows(when: When | undefined, a: Record<string, unknown>): boolean {
  if (!when) return true
  if (when === 'acs') return ACS.some((o) => count(a, o.id) > 0)
  return (a.move_type === 'between') === (when === 'between')
}

/** Pieces of furniture and appliances chosen so far (the footer's count). */
export const itemsChosen = (a: Record<string, unknown>): number =>
  [...FURNITURE, ...APPLIANCES].reduce((sum, o) => sum + count(a, o.id), 0)

/** YYYY-MM-DD, `days` from now, in UTC. */
const utcDay = (days: number, now = new Date()) =>
  new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10)

/** A day that exists: not 2026-02-31, not 2026-13-01. */
const isRealDate = (s: string) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export type MovingValidation =
  | { ok: true; answers: MovingValues }
  | { ok: false; fields: Record<string, FieldError> }

/**
 * Check what a browser sent. Returns only the fields this form has,
 * each proven to be one of its options, a whole number from 0 to
 * `MAX_COUNT`, or text no longer than `MAX_TEXT` — or says which
 * fields are wrong. Anything else in the body is dropped.
 */
export function validateMovingAnswers(raw: unknown, now = new Date()): MovingValidation {
  const a: Record<string, unknown> =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const answers: MovingValues = { form: MOVING_FORM }
  const fields: Record<string, FieldError> = {}

  const choice = (key: string, options: Option[], required = true) => {
    const v = a[key]
    if (v === undefined || v === null || v === '') {
      if (required) fields[key] = 'choose'
    } else if (typeof v === 'string' && options.some((o) => o.id === v)) {
      answers[key] = v
    } else {
      fields[key] = 'invalid'
    }
  }
  const text = (key: string, required: boolean) => {
    const v = a[key]
    if (v === undefined || v === null) {
      if (required) fields[key] = 'required'
      return
    }
    if (typeof v !== 'string') {
      fields[key] = 'invalid'
      return
    }
    // Control characters have no place in an answer, and the database
    // refuses some of them outright; the ones that flip text direction
    // could make a line in the inbox read backwards. Line breaks in a
    // note are kept.
    const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '').trim()
    if (!s) {
      if (required) fields[key] = 'required'
    } else if ([...s].length > MAX_TEXT) {
      fields[key] = 'too_long'
    } else {
      answers[key] = s
    }
  }

  const lang = a.lang
  if (lang === 'ar' || lang === 'en') answers.lang = lang
  else fields.lang = 'invalid'

  choice('move_type', MOVE_TYPES)
  // Only the city fields of the chosen kind of move are kept.
  if (a.move_type === 'between') {
    choice('from_city', CITIES)
    choice('to_city', CITIES)
  } else {
    choice('city', CITIES)
  }
  text('from_district', true)
  text('to_district', true)
  choice('from_floor', FLOORS)
  choice('to_floor', FLOORS)

  const date = a.move_date
  if (date === undefined || date === null || date === '') fields.move_date = 'required'
  else if (typeof date !== 'string' || !isRealDate(date)) fields.move_date = 'invalid'
  // "Today" on the customer's phone can be a day behind UTC's.
  else if (date < utcDay(-1, now)) fields.move_date = 'past'
  else answers.move_date = date

  for (const o of COUNTS) {
    const v = a[o.id] ?? 0
    if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_COUNT) answers[o.id] = v
    else fields[o.id] = 'invalid'
  }
  text('other_items', false)
  choice('cabinets', YES_NO)
  choice('pack_kitchen', YES_NO)
  // Asked only once an AC is added.
  if (shows('acs', answers)) choice('ac_install', YES_NO)
  text('name', true)
  choice('call_time', CALL_TIMES, false)
  text('notes', false)

  return Object.keys(fields).length ? { ok: false, fields } : { ok: true, answers }
}

export interface MovingAnswers {
  lang: FormLang
  /** Label → answer, in order, in the language asked for (free text
   *  stays as the customer typed it). */
  rows: { label: string; value: string }[]
  name: string | null
  /** "Riyadh, Al Malqa → Riyadh, Al Yasmin". */
  area: string | null
  /** YYYY-MM-DD. */
  date: string | null
  /** The short thank-you the customer gets in the chat, in the
   *  language they filled the form in. */
  thankYou: string
}

/**
 * Turn the answers into what people read: the rows (English for the
 * sales rep and the lead; the customer's own language for the summary
 * on the page) and the thank-you. Tolerant on purpose — it also reads
 * stored answers written by an earlier version of the form — so a
 * missing or unknown value becomes "—" or is shown as sent, never a throw.
 */
export function readMovingAnswers(a: Record<string, unknown>, rowsLang: FormLang = 'en'): MovingAnswers {
  const lang: FormLang = a.lang === 'ar' ? 'ar' : 'en'
  const text = (key: string): string | null => {
    const v = a[key]
    if (typeof v !== 'string' && typeof v !== 'number') return null
    // One answer, one line: a line break typed into a field must not
    // pass for another row of the form.
    return clip(String(v).replace(/\s+/g, ' ').trim()) || null
  }
  const pick = (key: string, options: Option[], l: FormLang): string | null => {
    const v = text(key)
    return v === null ? null : (options.find((o) => o.id === v)?.label[l] ?? v)
  }
  const comma = (l: FormLang) => (l === 'ar' ? '، ' : ', ')
  /** "Wardrobes ×3, Carpets ×4", only what the customer has. */
  const list = (items: Option[], l: FormLang): string[] =>
    items.filter((o) => count(a, o.id) > 0).map((o) => `${o.label[l]} ×${count(a, o.id)}`)

  const between = a.move_type === 'between'
  const side = (which: 'from' | 'to', l: FormLang) => ({
    city: pick(between ? `${which}_city` : 'city', CITIES, l),
    district: text(`${which}_district`),
  })
  const place = (which: 'from' | 'to', l: FormLang) => {
    const s = side(which, l)
    return [s.city, s.district].filter(Boolean).join(comma(l)) || '—'
  }
  const withFloor = (which: 'from' | 'to', l: FormLang) =>
    [place(which, l), pick(`${which}_floor`, FLOORS, l)].filter(Boolean).join(' · ')

  const date = text('move_date')
  const name = text('name')
  const none = (l: FormLang) => (l === 'ar' ? 'لا يوجد' : 'None')
  const some = (items: string[], l: FormLang) => items.join(comma(l)) || none(l)

  const l = rowsLang
  const acs = list(ACS, l)
  const acInstall = pick('ac_install', YES_NO, l)
  const rows = (
    [
      [L('Name', 'الاسم'), name],
      [L('Move', 'النقل'), pick('move_type', MOVE_TYPES, l)],
      [L('From', 'من'), withFloor('from', l)],
      [L('To', 'إلى'), withFloor('to', l)],
      [L('Date', 'التاريخ'), formatDate(date, l, true)],
      [L('Furniture', 'الأثاث'), some(list(FURNITURE, l), l)],
      [L('Not in the list', 'خارج القائمة'), text('other_items') ?? none(l)],
      [L('Appliances', 'الأجهزة'), some(list(APPLIANCES, l), l)],
      [L('Kitchen cabinets', 'خزائن المطبخ'), pick('cabinets', YES_NO, l)],
      [L('Pack kitchenware', 'تغليف الأواني'), pick('pack_kitchen', YES_NO, l)],
      [
        L('Air conditioners', 'المكيفات'),
        acs.length
          ? some(acs, l) + (acInstall ? ` · ${l === 'ar' ? 'التركيب' : 'install'}: ${acInstall}` : '')
          : none(l),
      ],
      [L('Curtains', 'الستائر'), some(list(CURTAINS, l), l)],
      [L('Call time', 'وقت الاتصال'), pick('call_time', CALL_TIMES, l) ?? (l === 'ar' ? 'أي وقت' : 'Any time')],
      [L('Notes', 'ملاحظات'), text('notes') ?? none(l)],
    ] as [L, string | null][]
  ).map(([label, value]) => ({ label: label[l], value: clip(value || '—') }))

  // The customer's own words for where: the district inside one city,
  // the city between two (the district again for "Another city").
  const spot = (which: 'from' | 'to') => {
    const s = side(which, lang)
    const namedCity = between && a[`${which}_city`] !== 'other' ? s.city : null
    return namedCity ?? s.district ?? s.city
  }
  const kinds = list([...FURNITURE, ...APPLIANCES], lang).length
  const when = formatDate(date, lang)
  const [from, to] = [spot('from'), spot('to')]
  const route = !!from && !!to && from !== to
  const thankYou =
    lang === 'ar'
      ? [
          `شكراً${name ? ` ${name}` : ''}. وصلتنا تفاصيل النقل`,
          [
            route && `من ${from} إلى ${to}`,
            when,
            kinds > 0 && `${arabicKinds(kinds)} من الأثاث والأجهزة`,
          ]
            .filter(Boolean)
            .join('، '),
        ]
          .filter(Boolean)
          .join(': ') + '. يتواصل معك فريق المبيعات قريباً.'
      : [
          `Thank you${name ? `, ${name}` : ''}. We received your moving details`,
          [
            route && `${from} to ${to}`,
            when,
            kinds > 0 && `${kinds} ${kinds === 1 ? 'kind' : 'kinds'} of furniture and appliances`,
          ]
            .filter(Boolean)
            .join(', '),
        ]
          .filter(Boolean)
          .join(': ') + '. Our sales team will contact you shortly.'

  const area = [place('from', 'en'), place('to', 'en')].every((p) => p === '—')
    ? null
    : clip(`${place('from', 'en')} → ${place('to', 'en')}`)
  return { lang, rows, name, area, date, thankYou }
}

/** No longer than the lead contract allows; never half an emoji. */
const clip = (s: string) => [...s].slice(0, MAX_TEXT).join('')

/** Arabic counts its nouns four ways. */
const arabicKinds = (n: number) =>
  n === 1 ? 'نوع واحد' : n === 2 ? 'نوعان' : n <= 10 ? `${n} أنواع` : `${n} نوعاً`

/** "2026-11-28" → "28 Nov 2026" / "28 نوفمبر 2026" (with the weekday
 *  when asked); anything else as sent. */
function formatDate(value: string | null, lang: FormLang, weekday = false): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    ...(weekday ? { weekday: 'short' as const } : {}),
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
