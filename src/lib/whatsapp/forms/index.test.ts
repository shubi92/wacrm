import { describe, expect, it } from 'vitest'
import { BOT_FORMS, formLang, mentionsForms, takeFormMarker } from './index'
import { readMovingAnswers } from './furniture-moving'

describe('takeFormMarker', () => {
  it('finds the form and removes the marker from the text', () => {
    expect(takeFormMarker('Tap below. [[FORM:furniture_moving]]')).toEqual({
      form: 'furniture_moving',
      text: 'Tap below. ',
    })
    expect(takeFormMarker('[[ form : FURNITURE_MOVING ]]').form).toBe('furniture_moving')
  })

  it('ignores a form that does not exist, but still never lets the marker through', () => {
    expect(takeFormMarker('Hi [[FORM:free_money]]')).toEqual({ form: null, text: 'Hi ' })
    expect(takeFormMarker('Hi there')).toEqual({ form: null, text: 'Hi there' })
  })

  it.each(['constructor', '__proto__', 'tostring', 'hasownproperty'])(
    'does not take %s for a form',
    (name) => {
      expect(takeFormMarker(`Hi [[FORM:${name}]]`)).toEqual({ form: null, text: 'Hi ' })
    },
  )

  it.each([
    '[[FORM:furniture-moving]]',
    '[[FORM: furniture moving]]',
    '[FORM:furniture_moving]',
    '[form sent]',
  ])('strips a mangled marker (%s) without sending a form for it', (mangled) => {
    expect(takeFormMarker(`Tap below. ${mangled}`)).toEqual({ form: null, text: 'Tap below. ' })
  })

  it('leaves ordinary brackets alone', () => {
    expect(takeFormMarker('Sizes [S, M, L] and a form to fill').text).toBe('Sizes [S, M, L] and a form to fill')
  })
})

describe('mentionsForms', () => {
  it('is how an account switches forms on', () => {
    expect(mentionsForms('For moving add [[FORM:furniture_moving]] after your reply.')).toBe(true)
    expect(mentionsForms('We are a cleaning company. Fill our form on the website.')).toBe(false)
    expect(mentionsForms(null)).toBe(false)
  })
})

describe('formLang', () => {
  it('opens the form in Arabic for an Arabic line and in English otherwise', () => {
    expect(formLang('يسعدنا نخدمك في النقل')).toBe('ar')
    expect(formLang('Happy to help with your move.')).toBe('en')
    // One Arabic word is enough: the customer is being spoken to in Arabic.
    expect(formLang('Hello أهلاً')).toBe('ar')
    expect(formLang('')).toBe('en')
  })
})

// A date that is never in the past, whenever the tests run.
const DATE = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10)

const ANSWERS = {
  lang: 'en',
  move_type: 'within',
  city: 'riyadh',
  from_district: 'Al Malqa',
  to_district: 'Al Yasmin',
  move_date: DATE,
  from_floor: '2',
  to_floor: 'ground',
  qty_wardrobes: 3,
  cabinets: 'no',
  pack_kitchen: 'yes',
  name: 'Noura',
  call_time: 'afternoon',
}

describe('BOT_FORMS', () => {
  const form = BOT_FORMS.furniture_moving

  it.each(Object.entries(BOT_FORMS))('%s: the button label fits WhatsApp\'s 20 characters', (_name, f) => {
    for (const label of Object.values(f.button)) {
      expect([...label].length).toBeGreaterThan(0)
      expect([...label].length).toBeLessThanOrEqual(20)
    }
  })

  it('has the moving form, with its button in both languages', () => {
    expect(form.button).toEqual({ en: 'Open form', ar: 'افتح النموذج' })
  })

  it.each([undefined, null, 'not json', 7, [], {}, { name: 'x' }, { ...ANSWERS, city: 'atlantis' }])(
    'validate turns junk down (%j)',
    (junk) => {
      expect(form.validate(junk).ok).toBe(false)
    },
  )

  it('validate passes clean answers, and read turns them into readable lines, a lead and a thank-you', () => {
    const checked = form.validate({ ...ANSWERS, hacked: true })
    if (!checked.ok) throw new Error(JSON.stringify(checked.fields))
    expect(checked.answers).not.toHaveProperty('hacked')

    const submission = form.read(checked.answers)
    const { rows } = readMovingAnswers(checked.answers)
    expect(submission.text.split('\n').slice(0, 4)).toEqual([
      '📋 Furniture moving form',
      'Name: Noura',
      'Move: Inside one city',
      'From: Riyadh, Al Malqa · 2nd floor',
    ])
    expect(submission.text).toBe(['📋 Furniture moving form', ...rows.map((r) => `${r.label}: ${r.value}`)].join('\n'))
    expect(submission.text).toContain('Furniture: Wardrobes ×3')
    expect(submission.text).not.toMatch(/SAR|price/i)
    expect(submission).toMatchObject({
      form: 'furniture_moving',
      note: `🤖 AI agent handed off: the customer sent the furniture moving form. Customer is ready: furniture moving, Noura, Riyadh, Al Malqa → Riyadh, Al Yasmin, ${DATE}. The answers are in the chat.`,
      lead: {
        service: 'furniture_moving',
        quoted_price_sar: null,
        customer_name: 'Noura',
        area: 'Riyadh, Al Malqa → Riyadh, Al Yasmin',
        preferred_date: DATE,
      },
    })
    expect(submission.lead.details).toEqual(rows.map((r) => ({ question: r.label, answer: r.value })))
    expect(submission.lead.details).toContainEqual({ question: 'Pack kitchenware', answer: 'Yes' })
    // Inside the lead contract's own limits (see lead.ts).
    expect(submission.lead.details.length).toBeLessThanOrEqual(30)
    expect(submission.thankYou).toMatch(/^Thank you, Noura\./)
  })

  it('thanks in Arabic for a form filled in Arabic, while the rep still reads English', () => {
    const checked = form.validate({ ...ANSWERS, lang: 'ar' })
    if (!checked.ok) throw new Error(JSON.stringify(checked.fields))
    const submission = form.read(checked.answers)
    expect(submission.thankYou).toMatch(/^شكراً Noura\./)
    expect(submission.text).toContain('Move: Inside one city')
  })

  it('read never throws, whatever was stored', () => {
    expect(() => form.read({})).not.toThrow()
    expect(() => form.read({ name: { toString: 1 }, qty_master: [] })).not.toThrow()
    expect(form.read({}).lead).toMatchObject({ service: 'furniture_moving', customer_name: null, area: null, preferred_date: null })
  })
})
