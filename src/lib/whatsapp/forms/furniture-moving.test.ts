import { describe, expect, it } from 'vitest'
import {
  MAX_COUNT,
  MAX_TEXT,
  MOVING_DEFAULTS,
  MOVING_FORM,
  MOVING_SCREENS,
  itemsChosen,
  readMovingAnswers,
  shows,
  validateMovingAnswers,
  type Field,
} from './furniture-moving'

// "Today" for every date check below.
const NOW = new Date('2026-11-21T10:00:00Z')

// What the page posts for the approved example: a move inside Riyadh.
const WITHIN = {
  lang: 'en',
  move_type: 'within',
  city: 'riyadh',
  from_district: 'Al Malqa',
  to_district: 'Al Yasmin',
  from_floor: '2',
  to_floor: 'ground',
  move_date: '2026-11-28',
  qty_master: 1,
  qty_wardrobes: 3,
  qty_sofas: 5,
  other_items: 'Piano, 2 large mirrors',
  qty_fridge: 1,
  qty_washer: 1,
  cabinets: 'no',
  pack_kitchen: 'yes',
  ac_split: 3,
  ac_install: 'yes',
  curtains_fabric: 4,
  name: 'Noura',
  call_time: 'afternoon',
}
const BETWEEN = { ...WITHIN, move_type: 'between', city: undefined, from_city: 'riyadh', to_city: 'jeddah' }

const check = (body: unknown) => validateMovingAnswers(body, NOW)
/** The fields turned down for `body`, or {} when it passed. */
const rejected = (body: unknown) => {
  const r = check(body)
  return r.ok ? {} : r.fields
}
const accepted = (body: unknown) => {
  const r = check(body)
  if (!r.ok) throw new Error(`rejected: ${JSON.stringify(r.fields)}`)
  return r.answers
}

describe('validateMovingAnswers — what passes', () => {
  it('keeps only the form\'s own fields, with every count present', () => {
    const answers = accepted({ ...WITHIN, phone: '966500000000', __proto__: { admin: true }, extra: { a: 1 } })
    expect(answers).toEqual({
      form: MOVING_FORM,
      lang: 'en',
      move_type: 'within',
      city: 'riyadh',
      from_district: 'Al Malqa',
      to_district: 'Al Yasmin',
      from_floor: '2',
      to_floor: 'ground',
      move_date: '2026-11-28',
      qty_master: 1,
      qty_kids_beds: 0,
      qty_wardrobes: 3,
      qty_sofas: 5,
      qty_majlis: 0,
      qty_carpets: 0,
      qty_dining: 0,
      qty_chairs: 0,
      qty_side_tables: 0,
      qty_screens: 0,
      qty_bookcase: 0,
      qty_desk: 0,
      qty_sports: 0,
      qty_fridge: 1,
      qty_oven: 0,
      qty_freezer: 0,
      qty_washer: 1,
      qty_dryer: 0,
      qty_dishwasher: 0,
      ac_split: 3,
      ac_window: 0,
      curtains_roller: 0,
      curtains_fabric: 4,
      other_items: 'Piano, 2 large mirrors',
      cabinets: 'no',
      pack_kitchen: 'yes',
      ac_install: 'yes',
      name: 'Noura',
      call_time: 'afternoon',
    })
  })

  it('never lets the browser say which form it is', () => {
    expect(accepted({ ...WITHIN, form: 'free_money' }).form).toBe(MOVING_FORM)
  })

  it('keeps only the city fields of the chosen kind of move', () => {
    const within = accepted({ ...WITHIN, from_city: 'jeddah', to_city: 'dammam' })
    expect(within).toMatchObject({ city: 'riyadh' })
    expect(within).not.toHaveProperty('from_city')
    expect(within).not.toHaveProperty('to_city')

    const between = accepted({ ...BETWEEN, city: 'kharj' })
    expect(between).toMatchObject({ from_city: 'riyadh', to_city: 'jeddah' })
    expect(between).not.toHaveProperty('city')
  })

  it('asks about installing ACs only when there is one', () => {
    const none = accepted({ ...WITHIN, ac_split: 0, ac_window: 0, ac_install: 'yes' })
    expect(none).not.toHaveProperty('ac_install')
    // Even a junk value is ignored then: the question was never shown.
    expect(accepted({ ...WITHIN, ac_split: 0, ac_install: 'maybe' })).not.toHaveProperty('ac_install')

    expect(rejected({ ...WITHIN, ac_split: 0, ac_window: 2, ac_install: undefined })).toEqual({ ac_install: 'choose' })
    expect(rejected({ ...WITHIN, ac_install: 'maybe' })).toEqual({ ac_install: 'invalid' })
  })

  it('takes the optional answers as optional', () => {
    const answers = accepted({ ...WITHIN, call_time: undefined, other_items: undefined, notes: '   ' })
    expect(answers).not.toHaveProperty('call_time')
    expect(answers).not.toHaveProperty('other_items')
    expect(answers).not.toHaveProperty('notes')
  })

  it('trims text and accepts it up to the limit, Arabic and emoji included', () => {
    const long = 'ن'.repeat(MAX_TEXT)
    const emoji = '🛋️'.repeat(MAX_TEXT / 2) // two code points each
    expect(accepted({ ...WITHIN, name: '  Noura  ', notes: long, other_items: emoji })).toMatchObject({
      name: 'Noura',
      notes: long,
      other_items: emoji,
    })
  })

  it('accepts every count from 0 to the most allowed', () => {
    expect(accepted({ ...WITHIN, qty_carpets: 0, qty_chairs: MAX_COUNT })).toMatchObject({
      qty_carpets: 0,
      qty_chairs: MAX_COUNT,
    })
  })

  it('accepts the page\'s own starting answers once the required ones are filled', () => {
    expect(
      check({
        ...MOVING_DEFAULTS,
        lang: 'ar',
        from_district: 'الملقا',
        to_district: 'الياسمين',
        from_floor: 'ground',
        to_floor: '4_plus',
        move_date: '2026-11-21',
        name: 'نورة',
      }).ok,
    ).toBe(true)
  })
})

describe('validateMovingAnswers — what is turned down', () => {
  it.each([undefined, null, 'x', 7, [], [WITHIN], '{"lang":"en"}'])('a body that is not an object (%j)', (body) => {
    expect(rejected(body)).toMatchObject({
      lang: 'invalid',
      move_type: 'choose',
      city: 'choose',
      from_district: 'required',
      to_district: 'required',
      from_floor: 'choose',
      to_floor: 'choose',
      move_date: 'required',
      cabinets: 'choose',
      pack_kitchen: 'choose',
      name: 'required',
    })
  })

  it.each([undefined, null, '', 'fr', 'AR', 1, ['ar']])('a language we do not have (%j)', (lang) => {
    expect(rejected({ ...WITHIN, lang })).toEqual({ lang: 'invalid' })
  })

  it.each(['move_type', 'city', 'from_floor', 'to_floor', 'cabinets', 'pack_kitchen'])(
    'a missing or unknown choice for %s',
    (key) => {
      for (const missing of [undefined, null, '']) {
        expect(rejected({ ...WITHIN, [key]: missing })).toMatchObject({ [key]: 'choose' })
      }
      for (const unknown of ['nope', 'RIYADH', 1, true, ['riyadh'], { id: 'riyadh' }]) {
        expect(rejected({ ...WITHIN, [key]: unknown })).toMatchObject({ [key]: 'invalid' })
      }
    },
  )

  it.each(['from_city', 'to_city'])('a missing or unknown %s on a move between cities', (key) => {
    expect(rejected({ ...BETWEEN, [key]: undefined })).toEqual({ [key]: 'choose' })
    expect(rejected({ ...BETWEEN, [key]: 'paris' })).toEqual({ [key]: 'invalid' })
  })

  it('does not accept an option of another question', () => {
    expect(rejected({ ...WITHIN, city: 'ground' })).toEqual({ city: 'invalid' })
    expect(rejected({ ...WITHIN, from_floor: 'riyadh' })).toEqual({ from_floor: 'invalid' })
    expect(rejected({ ...WITHIN, cabinets: 'morning' })).toEqual({ cabinets: 'invalid' })
  })

  it('an unknown call time, though leaving it out is fine', () => {
    expect(rejected({ ...WITHIN, call_time: 'midnight' })).toEqual({ call_time: 'invalid' })
    expect(rejected({ ...WITHIN, call_time: 3 })).toEqual({ call_time: 'invalid' })
    expect(rejected({ ...WITHIN, call_time: undefined })).toEqual({})
    expect(rejected({ ...WITHIN, call_time: '' })).toEqual({})
  })

  it.each(['from_district', 'to_district', 'name'])('required text %s', (key) => {
    for (const blank of [undefined, null, '', '   ', '\n\t']) {
      expect(rejected({ ...WITHIN, [key]: blank })).toEqual({ [key]: 'required' })
    }
    for (const notText of [7, true, ['a'], { toString: 1 }]) {
      expect(rejected({ ...WITHIN, [key]: notText })).toEqual({ [key]: 'invalid' })
    }
    expect(rejected({ ...WITHIN, [key]: 'x'.repeat(MAX_TEXT + 1) })).toEqual({ [key]: 'too_long' })
  })

  it.each(['other_items', 'notes'])('optional text %s that is too long or not text', (key) => {
    expect(rejected({ ...WITHIN, [key]: 'x'.repeat(MAX_TEXT + 1) })).toEqual({ [key]: 'too_long' })
    expect(rejected({ ...WITHIN, [key]: 5 })).toEqual({ [key]: 'invalid' })
    expect(rejected({ ...WITHIN, [key]: ['a'] })).toEqual({ [key]: 'invalid' })
  })

  it('a date that is missing, malformed, not a real day, or gone', () => {
    for (const missing of [undefined, null, '']) {
      expect(rejected({ ...WITHIN, move_date: missing })).toEqual({ move_date: 'required' })
    }
    for (const bad of ['28/11/2026', '2026-11-28T00:00:00Z', 'next week', '2026-2-3', 20261128, '2026-02-31', '2026-13-01', '2026-00-10', '2027-02-29']) {
      expect(rejected({ ...WITHIN, move_date: bad })).toEqual({ move_date: 'invalid' })
    }
    for (const past of ['2026-11-19', '2025-12-31', '1999-01-01']) {
      expect(rejected({ ...WITHIN, move_date: past })).toEqual({ move_date: 'past' })
    }
  })

  it('allows a day of slack for a phone whose "today" is behind UTC\'s', () => {
    expect(rejected({ ...WITHIN, move_date: '2026-11-20' })).toEqual({})
    expect(rejected({ ...WITHIN, move_date: '2026-11-21' })).toEqual({})
    expect(rejected({ ...WITHIN, move_date: '2028-02-29' })).toEqual({}) // a real leap day
  })

  it.each([-1, MAX_COUNT + 1, 1.5, '3', NaN, Infinity, true, [2], { n: 2 }, 1e21])(
    'a count of %j',
    (bad) => {
      expect(rejected({ ...WITHIN, qty_sofas: bad })).toEqual({ qty_sofas: 'invalid' })
      expect(rejected({ ...WITHIN, ac_window: bad })).toMatchObject({ ac_window: 'invalid' })
      expect(rejected({ ...WITHIN, curtains_roller: bad })).toEqual({ curtains_roller: 'invalid' })
    },
  )

  it('names every wrong field at once', () => {
    expect(rejected({ ...WITHIN, name: '', move_date: '2020-01-01', qty_desk: 99, to_floor: '9' })).toEqual({
      name: 'required',
      move_date: 'past',
      qty_desk: 'invalid',
      to_floor: 'invalid',
    })
  })
})

// ------------------------------------------------------------

const rowsOf = (a: ReturnType<typeof readMovingAnswers>) =>
  Object.fromEntries(a.rows.map((r) => [r.label, r.value]))
const row = (a: ReturnType<typeof readMovingAnswers>, label: string) =>
  a.rows.find((r) => r.label === label)?.value

describe('readMovingAnswers', () => {
  const answers = accepted(WITHIN)

  it('gives the sales rep the rows of the approved summary, in English', () => {
    const a = readMovingAnswers(answers)
    expect(a.rows.map((r) => r.label)).toEqual([
      'Name', 'Move', 'From', 'To', 'Date', 'Furniture', 'Not in the list', 'Appliances',
      'Kitchen cabinets', 'Pack kitchenware', 'Air conditioners', 'Curtains', 'Call time', 'Notes',
    ])
    expect(rowsOf(a)).toEqual({
      Name: 'Noura',
      Move: 'Inside one city',
      From: 'Riyadh, Al Malqa · 2nd floor',
      To: 'Riyadh, Al Yasmin · Ground floor',
      Date: 'Sat, 28 Nov 2026',
      Furniture: 'Master bedroom ×1, Wardrobes ×3, Sofa pieces ×5',
      'Not in the list': 'Piano, 2 large mirrors',
      Appliances: 'Fridge ×1, Washing machine ×1',
      'Kitchen cabinets': 'No',
      'Pack kitchenware': 'Yes',
      'Air conditioners': 'Split units ×3 · install: Yes',
      Curtains: 'Fabric curtains ×4',
      'Call time': 'Afternoon',
      Notes: 'None',
    })
    expect(a).toMatchObject({
      lang: 'en',
      name: 'Noura',
      date: '2026-11-28',
      area: 'Riyadh, Al Malqa → Riyadh, Al Yasmin',
    })
    expect(JSON.stringify(a)).not.toMatch(/SAR|price|ريال/i)
  })

  it('gives the customer the same rows in Arabic', () => {
    const a = readMovingAnswers({ ...answers, lang: 'ar', name: 'نورة', from_district: 'الملقا', to_district: 'الياسمين' }, 'ar')
    expect(rowsOf(a)).toEqual({
      الاسم: 'نورة',
      النقل: 'داخل نفس المدينة',
      من: 'الرياض، الملقا · الدور الثاني',
      إلى: 'الرياض، الياسمين · الدور الأرضي',
      التاريخ: 'السبت، 28 نوفمبر 2026',
      الأثاث: 'غرفة نوم رئيسية ×1، دواليب ×3، قطع كنب ×5',
      'خارج القائمة': 'Piano, 2 large mirrors',
      الأجهزة: 'ثلاجة ×1، غسالة ×1',
      'خزائن المطبخ': 'لا',
      'تغليف الأواني': 'نعم',
      المكيفات: 'مكيفات سبليت ×3 · التركيب: نعم',
      الستائر: 'ستائر قماش ×4',
      'وقت الاتصال': 'بعد الظهر',
      ملاحظات: 'لا يوجد',
    })
    // The lead's area stays in English whatever the page showed.
    expect(a.area).toBe('Riyadh, الملقا → Riyadh, الياسمين')
  })

  it('reads the rep\'s rows in English even for a form filled in Arabic', () => {
    const a = readMovingAnswers({ ...answers, lang: 'ar' })
    expect(a.lang).toBe('ar')
    expect(row(a, 'Move')).toBe('Inside one city')
    expect(a.thankYou).toMatch(/^شكراً Noura\./)
  })

  it('thanks the customer in the language they filled the form in', () => {
    expect(readMovingAnswers(answers).thankYou).toBe(
      'Thank you, Noura. We received your moving details: Al Malqa to Al Yasmin, 28 Nov 2026, 5 kinds of furniture and appliances. Our sales team will contact you shortly.',
    )
    expect(readMovingAnswers({ ...accepted(BETWEEN), lang: 'ar', name: 'نورة' }).thankYou).toBe(
      'شكراً نورة. وصلتنا تفاصيل النقل: من الرياض إلى جدة، 28 نوفمبر 2026، 5 أنواع من الأثاث والأجهزة. يتواصل معك فريق المبيعات قريباً.',
    )
  })

  it('uses the two cities for a move between cities', () => {
    const a = readMovingAnswers(accepted(BETWEEN))
    expect(row(a, 'Move')).toBe('Between two cities')
    expect(row(a, 'From')).toBe('Riyadh, Al Malqa · 2nd floor')
    expect(row(a, 'To')).toBe('Jeddah, Al Yasmin · Ground floor')
    expect(a.area).toBe('Riyadh, Al Malqa → Jeddah, Al Yasmin')
    expect(a.thankYou).toContain(': Riyadh to Jeddah, ')
  })

  it('names the district when the city is "Another city", and no route when both ends read the same', () => {
    const other = readMovingAnswers(accepted({ ...BETWEEN, to_city: 'other', to_district: 'Unaizah' }))
    expect(row(other, 'To')).toBe('Another city, Unaizah · Ground floor')
    expect(other.thankYou).toContain(': Riyadh to Unaizah, ')

    const same = readMovingAnswers(accepted({ ...WITHIN, to_district: 'Al Malqa' }))
    expect(same.thankYou).toBe(
      'Thank you, Noura. We received your moving details: 28 Nov 2026, 5 kinds of furniture and appliances. Our sales team will contact you shortly.',
    )
  })

  it('says "Any time" when no call time was chosen, and "None" for what the customer does not have', () => {
    const a = readMovingAnswers(
      accepted({
        ...WITHIN,
        call_time: undefined,
        other_items: undefined,
        qty_master: 0, qty_wardrobes: 0, qty_sofas: 0, qty_fridge: 0, qty_washer: 0,
        ac_split: 0, ac_install: undefined, curtains_fabric: 0,
      }),
    )
    expect(rowsOf(a)).toMatchObject({
      Furniture: 'None',
      'Not in the list': 'None',
      Appliances: 'None',
      'Air conditioners': 'None',
      Curtains: 'None',
      'Call time': 'Any time',
      Notes: 'None',
    })
    // Nothing counted: the thank-you does not mention kinds at all.
    expect(a.thankYou).toBe(
      'Thank you, Noura. We received your moving details: Al Malqa to Al Yasmin, 28 Nov 2026. Our sales team will contact you shortly.',
    )
    expect(row(readMovingAnswers({ lang: 'ar' }, 'ar'), 'وقت الاتصال')).toBe('أي وقت')
  })

  it('lists both kinds of AC and curtain, and the install answer only with an AC', () => {
    const a = readMovingAnswers(accepted({ ...WITHIN, ac_window: 2, ac_install: 'no', curtains_roller: 1 }))
    expect(row(a, 'Air conditioners')).toBe('Split units ×3, Window units ×2 · install: No')
    expect(row(a, 'Curtains')).toBe('Roller curtains ×1, Fabric curtains ×4')
    // Stored answers with an install answer but no AC: nothing to install.
    expect(row(readMovingAnswers({ ac_install: 'yes' }), 'Air conditioners')).toBe('None')
  })

  it('counts kinds, not pieces, and only furniture and appliances', () => {
    const one = readMovingAnswers({ lang: 'en', qty_carpets: 9, ac_split: 4, curtains_roller: 2 })
    expect(one.thankYou).toContain('1 kind of furniture and appliances')
  })

  it('counts kinds the way Arabic does', () => {
    const ids = ['master', 'kids_beds', 'wardrobes', 'sofas', 'majlis', 'carpets', 'dining', 'chairs', 'side_tables', 'screens', 'bookcase']
    const kinds = (n: number) =>
      readMovingAnswers({ lang: 'ar', ...Object.fromEntries(ids.slice(0, n).map((id) => [`qty_${id}`, 1])) }).thankYou
    expect(kinds(1)).toContain('نوع واحد من الأثاث')
    expect(kinds(2)).toContain('نوعان من الأثاث')
    expect(kinds(3)).toContain('3 أنواع من الأثاث')
    expect(kinds(10)).toContain('10 أنواع من الأثاث')
    expect(kinds(11)).toContain('11 نوعاً من الأثاث')
  })

  it('keeps every value inside the lead contract\'s 300 characters', () => {
    const long = 'x'.repeat(5000)
    const a = readMovingAnswers({ ...answers, city: long, from_district: long, to_district: long, notes: long, name: long })
    expect(Math.max(...a.rows.map((r) => [...r.value].length), [...a.area!].length)).toBe(MAX_TEXT)
    expect([...a.name!].length).toBe(MAX_TEXT)
  })

  it('never throws on answers that came back nearly empty or odd', () => {
    // Objects where text or a number belongs must not break the reader.
    const odd = readMovingAnswers({
      qty_master: { toString: 1 },
      qty_desk: '2',
      ac_split: [],
      from_district: { a: 1 },
      move_date: 'next week',
      city: 'taif',
      name: 7,
    })
    expect(row(odd, 'Furniture')).toBe('Desk ×2') // an older stored answer may hold "2"
    expect(row(odd, 'Date')).toBe('next week')
    expect(row(odd, 'From')).toBe('taif') // an unknown option is shown as sent
    expect(row(odd, 'Move')).toBe('—')
    expect(odd.name).toBe('7')

    const empty = readMovingAnswers({})
    expect(empty.thankYou).toBe('Thank you. We received your moving details. Our sales team will contact you shortly.')
    expect(empty).toMatchObject({ lang: 'en', name: null, area: null, date: null })
    expect(row(empty, 'Name')).toBe('—')
    expect(readMovingAnswers({ lang: 'ar' }).thankYou).toBe(
      'شكراً. وصلتنا تفاصيل النقل. يتواصل معك فريق المبيعات قريباً.',
    )
  })
})

// ------------------------------------------------------------

/** Every answerable field id on the page, sections and groups included. */
function ids(fields: Field[]): string[] {
  return fields.flatMap((f) => {
    if (f.t === 'section') return ids(f.fields)
    if (f.t === 'group') return [...f.items.map((o) => o.id), ...(f.after ? [f.after.id] : [])]
    return [f.id]
  })
}

describe('MOVING_SCREENS', () => {
  const onPage = MOVING_SCREENS.flatMap((s) => ids(s.fields))

  it('has four steps and no field twice', () => {
    expect(MOVING_SCREENS).toHaveLength(4)
    expect(new Set(onPage).size).toBe(onPage.length)
  })

  it('asks exactly what the server accepts: no field the server drops, none it expects unseen', () => {
    const full = { ...WITHIN, notes: 'Call before coming' }
    const kept = new Set([
      ...Object.keys(accepted(full)),
      ...Object.keys(accepted({ ...full, move_type: 'between', from_city: 'riyadh', to_city: 'jeddah' })),
    ])
    expect([...kept].filter((k) => k !== 'form' && k !== 'lang').sort()).toEqual([...onPage].sort())
  })

  it('never asks the questions the owner removed, or a price', () => {
    const words = JSON.stringify(MOVING_SCREENS)
    expect(words).not.toMatch(/lift|elevator|carton|dismantl|assembl|price|SAR|مصعد|كرتون|فك وتركيب|سعر|ريال/i)
  })

  it('gives every default an option the server accepts', () => {
    for (const [key, value] of Object.entries(MOVING_DEFAULTS)) {
      const between = key === 'from_city' || key === 'to_city'
      const body = { ...(between ? BETWEEN : WITHIN), [key]: value }
      expect(rejected(body), key).toEqual({})
    }
    // Kitchen answers start on No, the AC question on Yes.
    expect(MOVING_DEFAULTS).toMatchObject({ cabinets: 'no', pack_kitchen: 'no', ac_install: 'yes' })
    // No default where the customer has to answer.
    for (const key of ['from_floor', 'to_floor', 'from_district', 'to_district', 'move_date', 'name', 'call_time']) {
      expect(MOVING_DEFAULTS).not.toHaveProperty(key)
    }
  })
})

describe('shows / itemsChosen', () => {
  it('shows the one city inside a city and the two cities between', () => {
    expect(shows(undefined, {})).toBe(true)
    expect(shows('within', { move_type: 'within' })).toBe(true)
    expect(shows('between', { move_type: 'within' })).toBe(false)
    expect(shows('within', { move_type: 'between' })).toBe(false)
    expect(shows('between', { move_type: 'between' })).toBe(true)
    // Nothing chosen yet reads as inside one city, like the reader does.
    expect(shows('within', {})).toBe(true)
  })

  it('shows the install question once any AC is added', () => {
    expect(shows('acs', {})).toBe(false)
    expect(shows('acs', { ac_split: 0, ac_window: 0 })).toBe(false)
    expect(shows('acs', { ac_split: 1 })).toBe(true)
    expect(shows('acs', { ac_window: 2 })).toBe(true)
    expect(shows('acs', { qty_fridge: 3 })).toBe(false)
  })

  it('counts pieces of furniture and appliances, not ACs or curtains', () => {
    expect(itemsChosen({})).toBe(0)
    expect(itemsChosen(WITHIN)).toBe(1 + 3 + 5 + 1 + 1)
    expect(itemsChosen({ ac_split: 3, curtains_fabric: 4 })).toBe(0)
    expect(itemsChosen({ qty_sofas: -2, qty_desk: 'x', qty_oven: 2 })).toBe(2)
  })
})

describe('text a customer could use to mislead the team', () => {
  it('drops control characters, which the database would refuse', () => {
    const a = accepted({ ...WITHIN, name: 'No\u0000ura\u0007', notes: 'line one\nline two' })
    expect(a.name).toBe('Noura')
    expect(a.notes).toBe('line one\nline two') // a note may run over lines
    expect(rejected({ ...WITHIN, name: '\u0000\u0001' })).toEqual({ name: 'required' })
  })

  it('keeps every answer on its own line, so a name cannot pass for another row', () => {
    const a = readMovingAnswers({ ...WITHIN, name: 'Noura\nKitchen cabinets: Yes', notes: 'a\n\nb' })
    expect(row(a, 'Name')).toBe('Noura Kitchen cabinets: Yes')
    expect(row(a, 'Notes')).toBe('a b')
    expect(a.rows.every((r) => !/[\n\r]/.test(r.value))).toBe(true)
  })
})
