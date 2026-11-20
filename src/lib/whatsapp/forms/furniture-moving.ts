// ============================================================
// The furniture-moving form (a Meta "WhatsApp Flow", unrelated to this
// app's own Flows automation builder).
//
// One definition feeds both directions:
//   - `buildMovingFlowJson` → the Flow JSON pasted into WhatsApp
//     Manager (committed under docs/whatsapp-forms/, one per language);
//   - `readMovingAnswers`   → the customer's answers, as the rows the
//     sales rep reads in the inbox and in the lead.
//
// The questions are the ones the owner approved. WhatsApp caps labels
// (20 characters on text fields and dropdowns, 30 on tick/radio groups
// and their options), so a few long questions carry a shorter label.
// It also writes "(optional)" itself beside any field not required.
// No prices anywhere.
// ============================================================

export type FormLang = 'en' | 'ar'
type L = Record<FormLang, string>
const L = (en: string, ar: string): L => ({ en, ar })

interface Option {
  id: string
  label: L
}
const opt = (id: string, en: string, ar: string): Option => ({ id, label: L(en, ar) })

interface Item extends Option {
  /** For the "how many" dropdown when `label` is over 20 characters. */
  short?: L
}

const CITIES = [
  opt('riyadh', 'Riyadh', 'الرياض'),
  opt('kharj', 'Al Kharj', 'الخرج'),
  opt('jeddah', 'Jeddah', 'جدة'),
  opt('dammam', 'Dammam', 'الدمام'),
  opt('other', 'Another city', 'مدينة أخرى'),
]
const FLOORS = [
  opt('ground', 'Ground floor', 'الدور الأرضي'),
  opt('1', '1st floor', 'الدور الأول'),
  opt('2', '2nd floor', 'الدور الثاني'),
  opt('3', '3rd floor', 'الدور الثالث'),
  opt('4_plus', '4th floor or higher', 'الدور الرابع أو أعلى'),
]
const YES_NO = [opt('yes', 'Yes', 'نعم'), opt('no', 'No', 'لا')]
const CALL_TIMES = [
  opt('morning', 'Morning', 'الصباح'),
  opt('afternoon', 'Afternoon', 'بعد الظهر'),
  opt('evening', 'Evening', 'المساء'),
]
const MOVE_TYPES = [
  opt('within', 'Inside one city', 'داخل نفس المدينة'),
  opt('between', 'Between two cities', 'بين مدينتين'),
]

interface ItemGroup {
  /** Field name of the tick list. */
  id: string
  title: L
  items: Item[]
}

const FURNITURE_GROUPS: ItemGroup[] = [
  {
    id: 'bedrooms',
    title: L('Bedrooms', 'غرف النوم'),
    items: [
      opt('master', 'Master bedroom', 'غرفة نوم رئيسية'),
      opt('kids_beds', "Kids' beds", 'أسرّة أطفال'),
      opt('wardrobes', 'Wardrobes', 'دواليب'),
    ],
  },
  {
    id: 'living',
    title: L('Living areas', 'المجالس والمعيشة'),
    items: [
      opt('sofas', 'Sofa pieces', 'قطع كنب'),
      opt('majlis', 'Floor majlis', 'مجلس أرضي'),
      opt('carpets', 'Carpets', 'سجاد'),
      {
        ...opt('dining', 'Dining table with buffet', 'سفرة طعام مع بوفيه'),
        short: L('Dining table, buffet', 'سفرة طعام مع بوفيه'),
      },
      opt('chairs', 'Dining chairs', 'كراسي السفرة'),
      opt('side_tables', 'Side tables', 'طاولات خدمة'),
    ],
  },
  {
    id: 'other_furniture',
    title: L('Other items', 'قطع أخرى'),
    items: [
      opt('screens', 'Screens', 'شاشات'),
      opt('bookcase', 'Bookcase', 'مكتبة'),
      opt('desk', 'Desk', 'مكتب'),
      opt('sports', 'Sports equipment', 'أجهزة رياضية'),
    ],
  },
]

const APPLIANCE_GROUPS: ItemGroup[] = [
  {
    id: 'appliances',
    title: L('Appliances', 'الأجهزة'),
    items: [
      opt('fridge', 'Fridge', 'ثلاجة'),
      opt('oven', 'Oven', 'فرن'),
      opt('freezer', 'Freezer', 'فريزر'),
      opt('washer', 'Washing machine', 'غسالة'),
      opt('dryer', 'Dryer', 'مجفف'),
      opt('dishwasher', 'Dishwasher', 'غسالة صحون'),
    ],
  },
]

const AC_COUNTS = [
  opt('ac_split', 'Split units', 'مكيفات سبليت'),
  opt('ac_window', 'Window units', 'مكيفات شباك'),
]
const CURTAIN_COUNTS = [
  opt('curtains_roller', 'Roller curtains', 'ستائر رول'),
  opt('curtains_fabric', 'Fabric curtains', 'ستائر قماش'),
]

const T = {
  moveTitle: L('The move', 'تفاصيل النقل'),
  moveType: L('Where is the move?', 'أين النقل؟'),
  city: L('City', 'المدينة'),
  fromCity: L('From: city', 'النقل من: المدينة'),
  fromDistrict: L('From: district', 'النقل من: الحي'),
  toCity: L('To: city', 'النقل إلى: المدينة'),
  toDistrict: L('To: district', 'النقل إلى: الحي'),
  date: L('Moving date', 'تاريخ النقل'),
  fromFloor: L('Current home: floor', 'المنزل الحالي: الدور'),
  toFloor: L('New home: floor', 'المنزل الجديد: الدور'),
  furnitureTitle: L('Your furniture', 'الأثاث'),
  tickThenCount: L('Tick what you have, then choose how many.', 'اختر ما لديك ثم حدد العدد.'),
  countEach: L('Choose how many of each you have.', 'حدد العدد لكل قطعة لديك.'),
  otherItems: L('Not in the list?', 'قطع خارج القائمة'),
  otherItemsHelp: L(
    'Anything not in the list? Write it here.',
    'عندك قطع غير موجودة في القائمة؟ اكتبها هنا.',
  ),
  kitchenTitle: L('Kitchen and fittings', 'المطبخ والتجهيزات'),
  cabinets: L('Kitchen cabinets to move?', 'هل يوجد خزائن مطبخ للنقل؟'),
  packKitchen: L('Wrap and pack kitchenware?', 'نغلّف ونعبّئ أواني المطبخ؟'),
  packKitchenHelp: L('Kitchenware: plates, cups, pots.', 'أواني المطبخ: صحون، أكواب، قدور.'),
  acs: L('Air conditioners', 'المكيفات'),
  acInstall: L('Install ACs at the new home?', 'تركيب المكيفات بالمنزل الجديد؟'),
  curtains: L('Curtains', 'الستائر'),
  contactTitle: L('Contact', 'التواصل'),
  name: L('Your name', 'الاسم'),
  callTime: L('Best time to call', 'أفضل وقت للاتصال بك'),
  notes: L('Notes', 'ملاحظات'),
  notesHelp: L('Anything else we should know?', 'ملاحظات أخرى'),
  next: L('Continue', 'متابعة'),
  send: L('Send', 'إرسال'),
}

export const MOVING_FORM = 'furniture_moving'

/** How the "how many" lists appear on the two item screens. */
export type QuantityStyle =
  /** A number list (1–10) appears for each item the customer ticks. */
  | 'ticked'
  /** No ticks: every item has a number list starting at 0. The owner's
   *  agreed fallback if WhatsApp does not show/hide lists as documented. */
  | 'all'

const numbers = (from: number) =>
  Array.from({ length: 11 - from }, (_, i) => ({ id: String(from + i), title: String(from + i) }))

const source = (options: Option[], lang: FormLang) =>
  options.map((o) => ({ id: o.id, title: o.label[lang] }))

const shown = (item: Item) => `show_${item.id}`
const qty = (item: Item) => `qty_${item.id}`
const allItems = (groups: ItemGroup[]) => groups.flatMap((g) => g.items)

/**
 * The Flow JSON for one language. Static: no data endpoint, the four
 * screens navigate on the phone and the last one sends everything back
 * in one `nfm_reply` (see `readMovingAnswers`).
 */
export function buildMovingFlowJson(lang: FormLang, quantities: QuantityStyle = 'ticked') {
  const t = (l: L) => l[lang]
  const dropdown = (name: string, label: L, options: Option[], required = true) => ({
    type: 'Dropdown',
    name,
    label: t(label),
    required,
    'data-source': source(options, lang),
  })
  const radio = (name: string, label: L, options: Option[], required = true) => ({
    type: 'RadioButtonsGroup',
    name,
    label: t(label),
    required,
    'data-source': source(options, lang),
  })
  const count = (o: Option) => ({
    type: 'Dropdown',
    name: o.id,
    label: t(o.label),
    required: false,
    'init-value': '0',
    'data-source': numbers(0),
  })

  // Tick lists whose items reveal their own "how many" list, or (the
  // fallback) one number list per item.
  const itemFields = (groups: ItemGroup[]) =>
    groups.flatMap((g): Record<string, unknown>[] =>
      quantities === 'all'
        ? [
            { type: 'TextSubheading', text: t(g.title) },
            ...g.items.map((it) => ({
              type: 'Dropdown',
              name: qty(it),
              label: t(it.short ?? it.label),
              required: false,
              'init-value': '0',
              'data-source': numbers(0),
            })),
          ]
        : [
            {
              type: 'CheckboxGroup',
              name: g.id,
              label: t(g.title),
              required: false,
              'data-source': g.items.map((it) => ({
                id: it.id,
                title: t(it.label),
                'on-select-action': { name: 'update_data', payload: { [shown(it)]: true } },
                'on-unselect-action': { name: 'update_data', payload: { [shown(it)]: false } },
              })),
            },
            ...g.items.map((it) => ({
              type: 'Dropdown',
              name: qty(it),
              label: t(it.short ?? it.label),
              required: false,
              visible: `\${data.${shown(it)}}`,
              'init-value': '1',
              'data-source': numbers(1),
            })),
          ],
    )
  // Every "how many" list starts hidden: the screen before passes these.
  const hidden = (groups: ItemGroup[]) =>
    quantities === 'ticked'
      ? Object.fromEntries(allItems(groups).map((it) => [shown(it), false]))
      : {}
  const declared = (groups: ItemGroup[]) =>
    quantities === 'ticked'
      ? {
          data: Object.fromEntries(
            allItems(groups).map((it) => [shown(it), { type: 'boolean', __example__: false }]),
          ),
        }
      : {}
  const next = (screen: string, payload: Record<string, unknown>) => ({
    type: 'Footer',
    label: t(T.next),
    'on-click-action': { name: 'navigate', next: { type: 'screen', name: screen }, payload },
  })
  const answered = (screen: string, names: string[]) =>
    Object.fromEntries(names.map((n) => [n, `\${screen.${screen}.form.${n}}`]))
  const itemNames = (groups: ItemGroup[]) => [
    ...(quantities === 'ticked' ? groups.map((g) => g.id) : []),
    ...allItems(groups).map(qty),
  ]

  return {
    version: '7.3',
    screens: [
      {
        id: 'MOVE',
        title: t(T.moveTitle),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            radio('move_type', T.moveType, MOVE_TYPES),
            {
              type: 'If',
              condition: "${form.move_type} == 'between'",
              then: [dropdown('from_city', T.fromCity, CITIES)],
              else: [dropdown('city', T.city, CITIES)],
            },
            { type: 'TextInput', name: 'from_district', label: t(T.fromDistrict), 'input-type': 'text', required: true },
            {
              type: 'If',
              condition: "${form.move_type} == 'between'",
              then: [dropdown('to_city', T.toCity, CITIES)],
            },
            { type: 'TextInput', name: 'to_district', label: t(T.toDistrict), 'input-type': 'text', required: true },
            { type: 'DatePicker', name: 'move_date', label: t(T.date), required: true },
            dropdown('from_floor', T.fromFloor, FLOORS),
            dropdown('to_floor', T.toFloor, FLOORS),
            next('FURNITURE', hidden(FURNITURE_GROUPS)),
          ],
        },
      },
      {
        id: 'FURNITURE',
        title: t(T.furnitureTitle),
        ...declared(FURNITURE_GROUPS),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextBody', text: t(quantities === 'ticked' ? T.tickThenCount : T.countEach) },
            ...itemFields(FURNITURE_GROUPS),
            {
              type: 'TextArea',
              name: 'other_items',
              label: t(T.otherItems),
              'helper-text': t(T.otherItemsHelp),
              required: false,
            },
            next('KITCHEN', hidden(APPLIANCE_GROUPS)),
          ],
        },
      },
      {
        id: 'KITCHEN',
        title: t(T.kitchenTitle),
        ...declared(APPLIANCE_GROUPS),
        layout: {
          type: 'SingleColumnLayout',
          children: [
            ...itemFields(APPLIANCE_GROUPS),
            radio('cabinets', T.cabinets, YES_NO),
            radio('pack_kitchen', T.packKitchen, YES_NO),
            { type: 'TextCaption', text: t(T.packKitchenHelp) },
            { type: 'TextSubheading', text: t(T.acs) },
            ...AC_COUNTS.map(count),
            radio('ac_install', T.acInstall, YES_NO, false),
            { type: 'TextSubheading', text: t(T.curtains) },
            ...CURTAIN_COUNTS.map(count),
            next('CONTACT', {}),
          ],
        },
      },
      {
        id: 'CONTACT',
        title: t(T.contactTitle),
        terminal: true,
        success: true,
        layout: {
          type: 'SingleColumnLayout',
          children: [
            { type: 'TextInput', name: 'name', label: t(T.name), 'input-type': 'text', required: true },
            dropdown('call_time', T.callTime, CALL_TIMES),
            { type: 'TextArea', name: 'notes', label: t(T.notes), 'helper-text': t(T.notesHelp), required: false },
            {
              type: 'Footer',
              label: t(T.send),
              'on-click-action': {
                name: 'complete',
                payload: {
                  // Meta's reply does not say which form it is.
                  form: MOVING_FORM,
                  lang,
                  quantities,
                  ...answered('MOVE', [
                    'move_type', 'city', 'from_city', 'from_district', 'to_city',
                    'to_district', 'move_date', 'from_floor', 'to_floor',
                  ]),
                  ...answered('FURNITURE', [...itemNames(FURNITURE_GROUPS), 'other_items']),
                  ...answered('KITCHEN', [
                    ...itemNames(APPLIANCE_GROUPS), 'cabinets', 'pack_kitchen',
                    ...AC_COUNTS.map((o) => o.id), 'ac_install', ...CURTAIN_COUNTS.map((o) => o.id),
                  ]),
                  name: '${form.name}',
                  call_time: '${form.call_time}',
                  notes: '${form.notes}',
                },
              },
            },
          ],
        },
      },
    ],
  }
}

// ------------------------------------------------------------
// Reading the answers
// ------------------------------------------------------------

/** Longest free text we pass on (the lead contract's own limit). */
const MAX_TEXT = 300

export interface MovingAnswers {
  lang: FormLang
  /** What the sales rep reads, in order: label → answer, in English
   *  (free text stays as the customer typed it). */
  rows: { label: string; value: string }[]
  name: string | null
  /** "Riyadh, Al Malqa → Riyadh, Al Yasmin". */
  area: string | null
  /** As WhatsApp's date picker sends it: YYYY-MM-DD. */
  date: string | null
  /** The short thank-you the customer gets, in the form's language. */
  thankYou: string
}

/**
 * Turn the form's `response_json` (already parsed) into what the rep
 * and the customer see. Tolerant on purpose: this is customer-supplied
 * data from a form that may be edited in WhatsApp Manager later, so a
 * missing or unknown value becomes "—" or is shown as sent — never a throw.
 */
export function readMovingAnswers(a: Record<string, unknown>): MovingAnswers {
  const lang: FormLang = a.lang === 'ar' ? 'ar' : 'en'
  const text = (key: string): string | null => {
    const v = a[key]
    if (typeof v !== 'string' && typeof v !== 'number') return null
    return [...String(v).trim()].slice(0, MAX_TEXT).join('') || null
  }
  const pick = (key: string, options: Option[], l: FormLang = 'en'): string | null => {
    const v = text(key)
    return v === null ? null : (options.find((o) => o.id === v)?.label[l] ?? v)
  }
  const num = (key: string): number => {
    const v = a[key]
    const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
  }
  /**
   * "Wardrobes ×3, Carpets ×4". With tick lists only a ticked item
   * counts (1 if its number is missing) — a hidden number list still
   * sends its starting "1", so the numbers alone mean nothing there.
   * Without tick lists, any number above 0 counts. The form says which
   * kind it is (`quantities`); if it doesn't, a group that sent a tick
   * list is read as ticks.
   */
  const items = (groups: ItemGroup[]): string[] =>
    groups.flatMap((g) => {
      const sent = a[g.id]
      const ticked =
        a.quantities === 'all'
          ? null
          : Array.isArray(sent)
            ? sent.filter((v): v is string => typeof v === 'string')
            : a.quantities === 'ticked'
              ? []
              : null
      return g.items
        .filter((it) => (ticked ? ticked.includes(it.id) : num(qty(it)) > 0))
        .map((it) => `${it.label.en} ×${num(qty(it)) || 1}`)
    })

  const between = a.move_type === 'between'
  const side = (which: 'from' | 'to', l: FormLang) => ({
    city: pick(between ? `${which}_city` : 'city', CITIES, l),
    district: text(`${which}_district`),
  })
  const place = (which: 'from' | 'to') => {
    const s = side(which, 'en')
    return [s.city, s.district].filter(Boolean).join(', ') || '—'
  }
  const withFloor = (which: 'from' | 'to') =>
    [place(which), pick(`${which}_floor`, FLOORS)].filter(Boolean).join(' · ')

  const date = text('move_date')
  const furniture = items(FURNITURE_GROUPS)
  const appliances = items(APPLIANCE_GROUPS)
  const name = text('name')

  const acInstall = pick('ac_install', YES_NO)
  const rows = [
    ['Customer', name],
    ['Move', pick('move_type', MOVE_TYPES)],
    ['From', withFloor('from')],
    ['To', withFloor('to')],
    ['Moving date', formatDate(date, 'en')],
    ['Furniture', furniture.join(', ') || 'None'],
    ['Items not in the list', text('other_items') ?? 'None'],
    ['Appliances', appliances.join(', ') || 'None'],
    ['Kitchen cabinets', pick('cabinets', YES_NO)],
    ['Pack kitchenware', pick('pack_kitchen', YES_NO)],
    [
      'Air conditioners',
      `${num('ac_split')} split, ${num('ac_window')} window` +
        (acInstall ? ` · install at new home: ${acInstall}` : ''),
    ],
    ['Curtains', `${num('curtains_roller')} roller, ${num('curtains_fabric')} fabric`],
    ['Call', pick('call_time', CALL_TIMES)],
    ['Notes', text('notes') ?? 'None'],
  ].map(([label, value]) => ({ label: label as string, value: clip(value || '—') }))

  // The customer's own words for where: the district inside one city,
  // the city between two (the district again for "Another city").
  const spot = (which: 'from' | 'to') => {
    const s = side(which, lang)
    const namedCity = between && a[`${which}_city`] !== 'other' ? s.city : null
    return namedCity ?? s.district ?? s.city
  }
  const kinds = furniture.length + appliances.length
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

  const area = [place('from'), place('to')].every((p) => p === '—')
    ? null
    : clip(`${place('from')} → ${place('to')}`)
  return { lang, rows, name, area, date, thankYou }
}

/** No longer than the lead contract allows; never half an emoji. */
const clip = (s: string) => [...s].slice(0, MAX_TEXT).join('')

/** Arabic counts its nouns four ways. */
const arabicKinds = (n: number) =>
  n === 1 ? 'نوع واحد' : n === 2 ? 'نوعان' : n <= 10 ? `${n} أنواع` : `${n} نوعاً`

/** "2026-11-28" → "28 Nov 2026" / "28 نوفمبر 2026"; anything else as sent. */
function formatDate(value: string | null, lang: FormLang): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return value
  return d.toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}
