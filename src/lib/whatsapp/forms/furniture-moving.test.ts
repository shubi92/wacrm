import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildMovingFlowJson, readMovingAnswers, type FormLang } from './furniture-moving'

type Node = Record<string, unknown>

/** Every component on a screen, including the ones inside an `If`. */
function components(children: Node[]): Node[] {
  return children.flatMap((c) => [
    c,
    ...components([...((c.then as Node[]) ?? []), ...((c.else as Node[]) ?? [])]),
  ])
}
const len = (s: unknown) => [...String(s ?? '')].length

/** Meta's documented limits (Flow JSON components reference). */
function problems(flow: ReturnType<typeof buildMovingFlowJson>): string[] {
  const out: string[] = []
  const max = (what: string, value: unknown, limit: number) => {
    if (len(value) > limit) out.push(`${what} "${value}" is ${len(value)} chars (max ${limit})`)
  }
  for (const screen of flow.screens) {
    const all = components(screen.layout.children as Node[])
    if (all.length > 50) out.push(`${screen.id} has ${all.length} components (max 50)`)
    if (all.filter((c) => c.type === 'Footer').length !== 1) out.push(`${screen.id} needs exactly one Footer`)
    const names = all.map((c) => c.name).filter(Boolean)
    for (const n of names) if (names.indexOf(n) !== names.lastIndexOf(n)) out.push(`${screen.id}: duplicate name ${n}`)
    for (const c of all) {
      const options = Array.isArray(c['data-source']) ? (c['data-source'] as Node[]) : []
      switch (c.type) {
        case 'TextInput':
        case 'TextArea':
        case 'Dropdown':
          max(`${c.type} label`, c.label, 20)
          max('helper-text', c['helper-text'], 80)
          break
        case 'RadioButtonsGroup':
        case 'CheckboxGroup':
          max(`${c.type} label`, c.label, 30)
          if (options.length > 20) out.push(`${c.name} has ${options.length} options (max 20)`)
          break
        case 'DatePicker':
          max('DatePicker label', c.label, 40)
          break
        case 'TextSubheading':
          max('TextSubheading', c.text, 80)
          break
        case 'Footer':
          max('Footer label', c.label, 35)
          break
      }
      for (const o of options) max(`${c.name} option`, o.title, 30)
    }
  }
  return out
}

const FILES = path.join(process.cwd(), 'docs/whatsapp-forms')
const file = (lang: FormLang) => path.join(FILES, `furniture_moving_${lang}.json`)

describe.each(['en', 'ar'] as const)('moving form JSON (%s)', (lang) => {
  it.each(['ticked', 'all'] as const)('stays inside WhatsApp limits (%s quantities)', (style) => {
    expect(problems(buildMovingFlowJson(lang, style))).toEqual([])
  })

  it('sends back every field the last screen can see', () => {
    const flow = buildMovingFlowJson(lang)
    const sent = Object.keys(
      (components(flow.screens[3].layout.children as Node[]).find((c) => c.type === 'Footer')![
        'on-click-action'
      ] as { payload: Record<string, unknown> }).payload,
    )
    const fields = flow.screens.flatMap((s) =>
      components(s.layout.children as Node[]).map((c) => c.name).filter(Boolean),
    )
    expect(sent.sort()).toEqual([...fields, 'form', 'lang', 'quantities'].sort())
  })

  // The file is what gets pasted into WhatsApp Manager, so it must be
  // what the code builds. Regenerate with: UPDATE_FORMS=1 npx vitest run src/lib/whatsapp/forms
  it('matches the committed file', () => {
    const built = JSON.stringify(buildMovingFlowJson(lang), null, 2) + '\n'
    if (process.env.UPDATE_FORMS) writeFileSync(file(lang), built)
    expect(existsSync(file(lang)) && readFileSync(file(lang), 'utf8')).toBe(built)
  })
})

// What the phone sends back for the mock-up's example answers.
const WITHIN = {
  form: 'furniture_moving',
  lang: 'en',
  quantities: 'ticked',
  flow_token: 'furniture_moving:en',
  move_type: 'within',
  city: 'riyadh',
  from_district: 'Al Malqa',
  to_district: 'Al Yasmin',
  move_date: '2026-11-28',
  from_floor: '2',
  to_floor: 'ground',
  bedrooms: ['master', 'wardrobes'],
  qty_master: '1',
  qty_wardrobes: '3',
  qty_kids_beds: '2', // ticked, then unticked: its number stays behind
  living: ['sofas'],
  qty_sofas: '5',
  // `other_furniture` left out, as a phone may do for an untouched tick
  // list, while its hidden number lists still send their starting "1".
  qty_screens: '1',
  qty_desk: '1',
  other_items: 'Piano, 2 large mirrors',
  appliances: ['fridge', 'washer'],
  qty_fridge: '1',
  cabinets: 'no',
  pack_kitchen: 'yes',
  ac_split: '3',
  ac_window: '0',
  ac_install: 'yes',
  curtains_roller: '0',
  curtains_fabric: '4',
  name: 'Noura',
  call_time: 'afternoon',
}
const row = (a: ReturnType<typeof readMovingAnswers>, label: string) =>
  a.rows.find((r) => r.label === label)?.value

describe('readMovingAnswers', () => {
  it('gives the sales rep the rows from the approved mock-up', () => {
    const a = readMovingAnswers(WITHIN)
    expect(Object.fromEntries(a.rows.map((r) => [r.label, r.value]))).toEqual({
      Customer: 'Noura',
      Move: 'Inside one city',
      From: 'Riyadh, Al Malqa · 2nd floor',
      To: 'Riyadh, Al Yasmin · Ground floor',
      'Moving date': '28 Nov 2026',
      Furniture: 'Master bedroom ×1, Wardrobes ×3, Sofa pieces ×5',
      'Items not in the list': 'Piano, 2 large mirrors',
      // A ticked item whose number did not arrive still counts, as 1.
      Appliances: 'Fridge ×1, Washing machine ×1',
      'Kitchen cabinets': 'No',
      'Pack kitchenware': 'Yes',
      'Air conditioners': '3 split, 0 window · install at new home: Yes',
      Curtains: '0 roller, 4 fabric',
      Call: 'Afternoon',
      Notes: 'None',
    })
    expect(a).toMatchObject({ name: 'Noura', date: '2026-11-28', area: 'Riyadh, Al Malqa → Riyadh, Al Yasmin' })
    expect(a.thankYou).toBe(
      'Thank you, Noura. We received your moving details: Al Malqa to Al Yasmin, 28 Nov 2026, 5 kinds of furniture and appliances. Our sales team will contact you shortly.',
    )
  })

  it('uses the two cities for a move between cities, and thanks in Arabic', () => {
    const a = readMovingAnswers({
      ...WITHIN,
      lang: 'ar',
      move_type: 'between',
      city: undefined,
      from_city: 'riyadh',
      to_city: 'jeddah',
      name: 'نورة',
    })
    expect(row(a, 'Move')).toBe('Between two cities')
    expect(row(a, 'From')).toBe('Riyadh, Al Malqa · 2nd floor')
    expect(row(a, 'To')).toBe('Jeddah, Al Yasmin · Ground floor')
    expect(a.thankYou).toBe(
      'شكراً نورة. وصلتنا تفاصيل النقل: من الرياض إلى جدة، 28 نوفمبر 2026، 5 أنواع من الأثاث والأجهزة. يتواصل معك فريق المبيعات قريباً.',
    )
  })

  it('counts kinds the way Arabic does', () => {
    const kinds = (n: number) =>
      readMovingAnswers({
        lang: 'ar',
        quantities: 'all',
        ...Object.fromEntries(
          ['master', 'kids_beds', 'wardrobes', 'sofas', 'majlis', 'carpets', 'dining', 'chairs', 'side_tables', 'screens', 'bookcase']
            .slice(0, n)
            .map((id) => [`qty_${id}`, '1']),
        ),
      }).thankYou
    expect(kinds(1)).toContain('نوع واحد من الأثاث')
    expect(kinds(2)).toContain('نوعان من الأثاث')
    expect(kinds(3)).toContain('3 أنواع من الأثاث')
    expect(kinds(11)).toContain('11 نوعاً من الأثاث')
  })

  it('names the district when the city is "Another city", and no route when both ends read the same', () => {
    const other = readMovingAnswers({ ...WITHIN, move_type: 'between', from_city: 'riyadh', to_city: 'other', to_district: 'Unaizah' })
    expect(other.thankYou).toContain('Riyadh to Unaizah,')
    const same = readMovingAnswers({ ...WITHIN, to_district: 'Al Malqa' })
    expect(same.thankYou).toBe(
      'Thank you, Noura. We received your moving details: 28 Nov 2026, 5 kinds of furniture and appliances. Our sales team will contact you shortly.',
    )
  })

  it('reads the fallback form too: a number above 0 means the customer has it', () => {
    const a = readMovingAnswers({ lang: 'en', qty_master: '0', qty_carpets: '4', qty_oven: '2' })
    expect(row(a, 'Furniture')).toBe('Carpets ×4')
    expect(row(a, 'Appliances')).toBe('Oven ×2')
  })

  it('keeps every value inside the lead contract\'s 300 characters', () => {
    const long = 'x'.repeat(5000)
    const a = readMovingAnswers({ ...WITHIN, city: long, from_district: long, to_district: long, notes: long })
    expect(Math.max(...a.rows.map((r) => [...r.value].length), [...a.area!].length)).toBe(300)
  })

  it('never throws on a form that came back nearly empty or odd', () => {
    // Objects where text or a number belongs must not break the reader.
    const odd = readMovingAnswers({ quantities: 'ticked', bedrooms: [{ toString: 1 }, 'master'], qty_master: { toString: 1 }, ac_split: [] })
    expect(row(odd, 'Furniture')).toBe('Master bedroom ×1')
    const a = readMovingAnswers({ move_date: 'next week', city: 'taif', bedrooms: 'master', name: 7 })
    expect(row(a, 'Moving date')).toBe('next week')
    expect(row(a, 'From')).toBe('taif') // an unknown option is shown as sent
    expect(row(a, 'Furniture')).toBe('None')
    expect(row(a, 'Move')).toBe('—')
    expect(a.name).toBe('7')
    expect(readMovingAnswers({}).thankYou).toBe(
      'Thank you. We received your moving details. Our sales team will contact you shortly.',
    )
    expect(readMovingAnswers({}).area).toBeNull()
  })
})
