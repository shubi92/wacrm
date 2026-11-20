import { describe, expect, it } from 'vitest'
import { formLang, formMessage, readFormResponse, takeFormMarker } from './index'

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
})

describe('formMessage', () => {
  it('picks the Arabic form for an Arabic line and the English one otherwise', () => {
    expect(formMessage('furniture_moving', formLang('يسعدنا نخدمك في النقل'))).toEqual({
      flowName: 'furniture_moving_ar',
      buttonLabel: 'افتح النموذج',
      flowToken: 'furniture_moving:ar',
    })
    expect(formMessage('furniture_moving', formLang('Happy to help with your move.'))).toEqual({
      flowName: 'furniture_moving_en',
      buttonLabel: 'Open form',
      flowToken: 'furniture_moving:en',
    })
  })
})

const ANSWERS = {
  form: 'furniture_moving',
  lang: 'en',
  flow_token: 'furniture_moving:en',
  move_type: 'within',
  city: 'riyadh',
  from_district: 'Al Malqa',
  to_district: 'Al Yasmin',
  move_date: '2026-11-28',
  from_floor: '2',
  to_floor: 'ground',
  bedrooms: ['wardrobes'],
  qty_wardrobes: '3',
  cabinets: 'no',
  pack_kitchen: 'yes',
  name: 'Noura',
  call_time: 'afternoon',
}

describe('readFormResponse', () => {
  it('turns the moving form into readable lines, a lead and a thank-you', () => {
    const { text, submission } = readFormResponse(JSON.stringify(ANSWERS))
    expect(text.split('\n').slice(0, 4)).toEqual([
      '📋 Furniture moving form',
      'Customer: Noura',
      'Move: Inside one city',
      'From: Riyadh, Al Malqa · 2nd floor',
    ])
    expect(text).toContain('Furniture: Wardrobes ×3')
    expect(text).not.toMatch(/SAR|price/i)
    expect(submission).toMatchObject({
      form: 'furniture_moving',
      note: '🤖 AI agent handed off: the customer sent the furniture moving form. Customer is ready: furniture moving, Noura, Riyadh, Al Malqa → Riyadh, Al Yasmin, 2026-11-28. The answers are in the chat.',
      lead: {
        service: 'furniture_moving',
        quoted_price_sar: null,
        customer_name: 'Noura',
        area: 'Riyadh, Al Malqa → Riyadh, Al Yasmin',
        preferred_date: '2026-11-28',
      },
    })
    expect(submission!.lead.details).toContainEqual({ question: 'Pack kitchenware', answer: 'Yes' })
    // Inside the lead contract's own limits (see lead.ts).
    expect(submission!.lead.details.length).toBeLessThanOrEqual(30)
    expect(submission!.thankYou).toMatch(/^Thank you, Noura\./)
  })

  it('knows the form by the token when the form did not name itself', () => {
    const { submission } = readFormResponse(
      JSON.stringify({ ...ANSWERS, form: undefined, lang: undefined, flow_token: 'furniture_moving:ar' }),
    )
    expect(submission?.form).toBe('furniture_moving')
    expect(submission?.thankYou).toMatch(/^شكراً Noura\./)
  })

  it('shows a form it does not know as it came, and leaves it to a person', () => {
    expect(readFormResponse('{"flow_token":"x","rating":"5","tags":["a","b"]}')).toEqual({
      text: '📋 Form response\nrating: 5\ntags: ["a","b"]',
      submission: null,
    })
  })

  it('caps what an unknown form can put in the inbox', () => {
    const many = Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'x'.repeat(5000)]))
    const { text } = readFormResponse(JSON.stringify(many))
    expect(text.split('\n')).toHaveLength(1 + 40)
    expect(text.length).toBeLessThan(41 * 400)
  })

  it.each([undefined, '', 'not json', '[1,2]', 'null'])('never throws on %j', (bad) => {
    expect(readFormResponse(bad)).toEqual({
      text: '📋 Form response (could not be read)',
      submission: null,
    })
  })
})
