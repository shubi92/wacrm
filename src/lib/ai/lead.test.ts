import { describe, it, expect } from 'vitest'
import {
  LEAD_SERVICES,
  hasLeadBlock,
  parseLeadBlock,
  stripLeadBlocks,
  type HandoffLead,
} from './lead'

const LEAD: HandoffLead = {
  service: 'ac_cleaning',
  details: [
    { question: 'كم عدد المكيفات؟', answer: '٣ مكيفات' },
    { question: 'هل يوجد مكيف مخفي؟', answer: 'لا' },
  ],
  quoted_price_sar: 300,
  customer_name: 'أحمد',
  area: 'الرياض - حي النرجس',
  preferred_date: 'يوم الخميس العصر',
}

const block = (value: unknown) => `<lead>${JSON.stringify(value)}</lead>`

describe('parseLeadBlock', () => {
  it('parses a well-formed block to the contract shape', () => {
    expect(parseLeadBlock(`<reply>تم [[HANDOFF]]</reply>\n${block(LEAD)}`)).toEqual(LEAD)
  })

  it('drops keys that are not part of the contract', () => {
    expect(parseLeadBlock(block({ ...LEAD, phone: '0550000000' }))).toEqual(LEAD)
  })

  it('parses JSON wrapped in a markdown fence', () => {
    const json = JSON.stringify(LEAD, null, 2)
    expect(parseLeadBlock(`<lead>\n\`\`\`json\n${json}\n\`\`\`\n</lead>`)).toEqual(LEAD)
    expect(parseLeadBlock(`<lead>\`\`\`\n${json}\n\`\`\`</lead>`)).toEqual(LEAD)
  })

  it('returns null when there is no block', () => {
    expect(parseLeadBlock('<reply>أهلاً</reply>')).toBeNull()
    expect(parseLeadBlock('')).toBeNull()
  })

  it.each([
    ['no closing tag (cut off)', `<lead>${JSON.stringify(LEAD)}`],
    ['invalid JSON', '<lead>{"service": "ac_cleaning", </lead>'],
    ['a JSON array', block([LEAD])],
    ['a JSON string', block('ac_cleaning')],
    ['a JSON number', block(300)],
    ['JSON null', block(null)],
    ['an empty block', '<lead></lead>'],
    ['a whitespace-only block', '<lead>  \n </lead>'],
  ])('returns null for %s', (_name, raw) => {
    expect(parseLeadBlock(raw)).toBeNull()
  })

  it('accepts every listed service', () => {
    for (const service of LEAD_SERVICES) {
      expect(parseLeadBlock(block({ ...LEAD, service }))?.service).toBe(service)
    }
  })

  it('falls back to "other" for an unknown or missing service', () => {
    expect(parseLeadBlock(block({ ...LEAD, service: 'car_wash' }))?.service).toBe('other')
    expect(parseLeadBlock(block({ ...LEAD, service: null }))?.service).toBe('other')
    expect(parseLeadBlock(block({}))?.service).toBe('other')
  })

  it('fills every field of an empty object with its empty value', () => {
    expect(parseLeadBlock(block({}))).toEqual({
      service: 'other',
      details: [],
      quoted_price_sar: null,
      customer_name: null,
      area: null,
      preferred_date: null,
    })
  })

  it('treats details that are not an array as none', () => {
    expect(parseLeadBlock(block({ ...LEAD, details: 'ثلاثة مكيفات' }))?.details).toEqual([])
    expect(parseLeadBlock(block({ ...LEAD, details: { question: 'q', answer: 'a' } }))?.details).toEqual([])
    expect(parseLeadBlock(block({ ...LEAD, details: null }))?.details).toEqual([])
  })

  it('drops detail entries without both a question and an answer', () => {
    const details = [
      { question: 'كم عدد المكيفات؟', answer: 3 },
      { question: 'بدون جواب' },
      { answer: 'بدون سؤال' },
      { question: '  ', answer: 'سؤال فارغ' },
      { question: 'جواب فارغ', answer: '' },
      null,
      'نص',
      42,
      { question: ' هل يوجد مكيف مخفي؟ ', answer: ' لا ' },
    ]
    expect(parseLeadBlock(block({ ...LEAD, details }))?.details).toEqual([
      { question: 'كم عدد المكيفات؟', answer: '3' },
      { question: 'هل يوجد مكيف مخفي؟', answer: 'لا' },
    ])
  })

  it.each([
    [300, 300],
    [299.5, 299.5],
    ['300', 300],
    [' 300 ', 300],
    [0, null],
    ['0', null],
    [-50, null],
    ['-50', null],
    ['abc', null],
    ['300 SAR', null],
    [null, null],
    [true, null],
  ])('reads quoted_price_sar %j as %j', (given, expected) => {
    expect(parseLeadBlock(block({ ...LEAD, quoted_price_sar: given }))?.quoted_price_sar).toBe(expected)
  })

  it('reads a missing quoted_price_sar as null', () => {
    // JSON.stringify drops an undefined key, so the block has no price at all
    expect(parseLeadBlock(block({ ...LEAD, quoted_price_sar: undefined }))?.quoted_price_sar).toBeNull()
  })

  it('turns blank name, area and date into null and trims the rest', () => {
    expect(
      parseLeadBlock(block({ ...LEAD, customer_name: '', area: '   ', preferred_date: '\n\t' })),
    ).toEqual({ ...LEAD, customer_name: null, area: null, preferred_date: null })
    expect(parseLeadBlock(block({ ...LEAD, customer_name: '  أحمد  ' }))?.customer_name).toBe('أحمد')
    expect(parseLeadBlock(block({ ...LEAD, area: ['الرياض'] }))?.area).toBeNull()
  })

  it('caps over-long strings at 300 characters', () => {
    const long = 'ن'.repeat(500)
    const lead = parseLeadBlock(
      block({ ...LEAD, customer_name: long, details: [{ question: long, answer: long }] }),
    )
    expect(lead?.customer_name).toBe('ن'.repeat(300))
    expect(lead?.details).toEqual([{ question: 'ن'.repeat(300), answer: 'ن'.repeat(300) }])
  })

  it('caps details at 30 entries, keeping the first ones', () => {
    const details = Array.from({ length: 40 }, (_, i) => ({ question: `س${i}`, answer: `ج${i}` }))
    const lead = parseLeadBlock(block({ ...LEAD, details }))
    expect(lead?.details).toHaveLength(30)
    expect(lead?.details[29]).toEqual({ question: 'س29', answer: 'ج29' })
  })

  it('uses the last block when there are two', () => {
    const raw = `${block({ ...LEAD, customer_name: 'الأول' })}\n${block({ ...LEAD, customer_name: 'الأخير' })}`
    expect(parseLeadBlock(raw)?.customer_name).toBe('الأخير')
  })

  it('keeps the last complete block when a later one was cut off', () => {
    expect(parseLeadBlock(`${block(LEAD)}\n<lead>{"service":`)).toEqual(LEAD)
  })

  it('reads a block whose tags or wrapping are slightly off', () => {
    const json = JSON.stringify(LEAD)
    expect(parseLeadBlock(`<LEAD>${json}</LEAD>`)).toEqual(LEAD)
    expect(parseLeadBlock(`<lead >${json}</ lead>`)).toEqual(LEAD)
    expect(parseLeadBlock(`<lead>Here it is: ${json}</lead>`)).toEqual(LEAD)
  })

  it.each([
    ['٣٠٠', 300],
    ['1,200', 1200],
    ['300 ريال', null],
  ])('reads a price typed as %s', (typed, expected) => {
    expect(parseLeadBlock(block({ ...LEAD, quoted_price_sar: typed }))?.quoted_price_sar).toBe(expected)
  })

  it('never lets a loosely tagged block through to customer-visible text', () => {
    const json = JSON.stringify(LEAD)
    for (const leaky of [`ok <lead >${json}</lead>`, `ok <LEAD>${json}</LEAD>`, `ok <Lead>${json}`]) {
      expect(stripLeadBlocks(leaky).trim()).toBe('ok')
    }
    // …without eating ordinary words.
    expect(stripLeadBlocks('<leader> stays')).toBe('<leader> stays')
  })
})

describe('hasLeadBlock', () => {
  it('is true for a complete or an unclosed block', () => {
    expect(hasLeadBlock(`تم ${block(LEAD)}`)).toBe(true)
    expect(hasLeadBlock('تم <lead>{"service":')).toBe(true)
  })

  it('is false without an opening tag', () => {
    expect(hasLeadBlock('تم، سيتواصل معك الفريق')).toBe(false)
    expect(hasLeadBlock('تم </lead>')).toBe(false)
  })
})

describe('stripLeadBlocks', () => {
  it('leaves text without a block untouched', () => {
    expect(stripLeadBlocks('تم، سيتواصل معك الفريق')).toBe('تم، سيتواصل معك الفريق')
  })

  it('removes a complete block and keeps the text around it', () => {
    expect(stripLeadBlocks(`قبل ${block(LEAD)} بعد`)).toBe('قبل  بعد')
  })

  it('removes an unclosed block through to the end of the text', () => {
    expect(stripLeadBlocks('قبل <lead>{"service": "ac_cleaning",\n"area": "الرياض')).toBe('قبل ')
  })

  it('removes every block when there are several', () => {
    expect(stripLeadBlocks(`أ${block(LEAD)}ب${block({})}ج<lead>{"service":`)).toBe('أبج')
  })

  it('removes a stray closing tag', () => {
    expect(stripLeadBlocks('قبل </lead> بعد')).toBe('قبل  بعد')
  })
})
