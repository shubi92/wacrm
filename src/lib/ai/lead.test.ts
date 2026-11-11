import { describe, it, expect } from 'vitest'
import {
  LEAD_SERVICES,
  hasLeadTag,
  parseLeadBlock,
  maskLeadBlocks,
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
/** Just the lead: most tests here don't care whether the customer said yes. */
const leadOf = (raw: string) => parseLeadBlock(raw)?.lead ?? null

describe('parseLeadBlock', () => {
  it('parses a well-formed block to the contract shape', () => {
    expect(leadOf(`<reply>تم [[HANDOFF]]</reply>\n${block(LEAD)}`)).toEqual(LEAD)
  })

  it('drops keys that are not part of the contract', () => {
    expect(leadOf(block({ ...LEAD, phone: '0550000000' }))).toEqual(LEAD)
  })

  it('parses JSON wrapped in a markdown fence', () => {
    const json = JSON.stringify(LEAD, null, 2)
    expect(leadOf(`<lead>\n\`\`\`json\n${json}\n\`\`\`\n</lead>`)).toEqual(LEAD)
    expect(leadOf(`<lead>\`\`\`\n${json}\n\`\`\`</lead>`)).toEqual(LEAD)
  })

  it('returns null when there is no block', () => {
    expect(leadOf('<reply>أهلاً</reply>')).toBeNull()
    expect(leadOf('')).toBeNull()
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
    expect(leadOf(raw)).toBeNull()
  })

  it('accepts every listed service', () => {
    for (const service of LEAD_SERVICES) {
      expect(leadOf(block({ ...LEAD, service }))?.service).toBe(service)
    }
  })

  it('falls back to "other" for an unknown or missing service', () => {
    expect(leadOf(block({ ...LEAD, service: 'car_wash' }))?.service).toBe('other')
    expect(leadOf(block({ ...LEAD, service: null }))?.service).toBe('other')
    expect(leadOf(block({ customer_name: 'أحمد' }))?.service).toBe('other')
  })

  it('does not take an object that says nothing for a lead', () => {
    expect(leadOf(block({}))).toBeNull()
    expect(
      leadOf(
        block({ service: null, details: [], quoted_price_sar: null, customer_name: null, area: '', preferred_date: null }),
      ),
    ).toBeNull()
    // …but one fact is enough.
    expect(leadOf(block({ service: 'pest_control' }))).toMatchObject({ service: 'pest_control', details: [] })
  })

  it('keeps a yes/no answer and never splits an emoji when cutting long text', () => {
    const lead = leadOf(
      block({ ...LEAD, details: [{ question: 'مفروشة؟', answer: true }], area: 'ا'.repeat(299) + '🙂🙂' }),
    )
    expect(lead?.details).toEqual([{ question: 'مفروشة؟', answer: 'true' }])
    expect(lead?.area).toBe('ا'.repeat(299) + '🙂')
  })

  it('treats details that are not an array as none', () => {
    expect(leadOf(block({ ...LEAD, details: 'ثلاثة مكيفات' }))?.details).toEqual([])
    expect(leadOf(block({ ...LEAD, details: { question: 'q', answer: 'a' } }))?.details).toEqual([])
    expect(leadOf(block({ ...LEAD, details: null }))?.details).toEqual([])
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
    expect(leadOf(block({ ...LEAD, details }))?.details).toEqual([
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
    ['300 SAR', 300],
    [null, null],
    [true, null],
  ])('reads quoted_price_sar %j as %j', (given, expected) => {
    expect(leadOf(block({ ...LEAD, quoted_price_sar: given }))?.quoted_price_sar).toBe(expected)
  })

  it('reads a missing quoted_price_sar as null', () => {
    // JSON.stringify drops an undefined key, so the block has no price at all
    expect(leadOf(block({ ...LEAD, quoted_price_sar: undefined }))?.quoted_price_sar).toBeNull()
  })

  it('turns blank name, area and date into null and trims the rest', () => {
    expect(
      leadOf(block({ ...LEAD, customer_name: '', area: '   ', preferred_date: '\n\t' })),
    ).toEqual({ ...LEAD, customer_name: null, area: null, preferred_date: null })
    expect(leadOf(block({ ...LEAD, customer_name: '  أحمد  ' }))?.customer_name).toBe('أحمد')
    expect(leadOf(block({ ...LEAD, area: ['الرياض'] }))?.area).toBeNull()
  })

  it('caps over-long strings at 300 characters', () => {
    const long = 'ن'.repeat(500)
    const lead = leadOf(
      block({ ...LEAD, customer_name: long, details: [{ question: long, answer: long }] }),
    )
    expect(lead?.customer_name).toBe('ن'.repeat(300))
    expect(lead?.details).toEqual([{ question: 'ن'.repeat(300), answer: 'ن'.repeat(300) }])
  })

  it('caps details at 30 entries, keeping the first ones', () => {
    const details = Array.from({ length: 40 }, (_, i) => ({ question: `س${i}`, answer: `ج${i}` }))
    const lead = leadOf(block({ ...LEAD, details }))
    expect(lead?.details).toHaveLength(30)
    expect(lead?.details[29]).toEqual({ question: 'س29', answer: 'ج29' })
  })

  it('uses the last block when there are two', () => {
    const raw = `${block({ ...LEAD, customer_name: 'الأول' })}\n${block({ ...LEAD, customer_name: 'الأخير' })}`
    expect(leadOf(raw)?.customer_name).toBe('الأخير')
  })

  it('keeps the last complete block when a later one was cut off', () => {
    expect(leadOf(`${block(LEAD)}\n<lead>{"service":`)).toEqual(LEAD)
  })

  it('reads a block whose tags or wrapping are slightly off', () => {
    const json = JSON.stringify(LEAD)
    expect(leadOf(`<LEAD>${json}</LEAD>`)).toEqual(LEAD)
    expect(leadOf(`<lead >${json}</ lead>`)).toEqual(LEAD)
    expect(leadOf(`<lead>Here it is: ${json}</lead>`)).toEqual(LEAD)
  })

  it.each([
    ['٣٠٠', 300],
    ['1,200', 1200],
    ['300 ريال', 300],
    ['300-400', null],
  ])('reads a price typed as %s', (typed, expected) => {
    expect(leadOf(block({ ...LEAD, quoted_price_sar: typed }))?.quoted_price_sar).toBe(expected)
  })
})

describe('hasLeadTag', () => {
  it('spots an opening or a closing tag, however sloppily written', () => {
    for (const t of ['تم <lead>{', 'تم </lead>', '<LEAD>', '<lead >', '</ Lead >']) {
      expect(hasLeadTag(t)).toBe(true)
    }
  })

  it('leaves ordinary text and look-alike words alone', () => {
    expect(hasLeadTag('تم، سيتواصل معك الفريق')).toBe(false)
    expect(hasLeadTag('<leader> and <lead-in>')).toBe(false)
  })
})

describe('maskLeadBlocks', () => {
  it('swaps each complete block for the marker and keeps the text around it', () => {
    expect(maskLeadBlocks(`قبل ${block(LEAD)} بعد <LEAD >${JSON.stringify(LEAD)}</lead>`, '§')).toBe('قبل § بعد §')
  })

  it('also masks a block it cannot read, so its position still counts', () => {
    expect(maskLeadBlocks('تم <lead>{"service": </lead>', '§')).toBe('تم §')
  })

  it('drops a block that says nothing', () => {
    expect(maskLeadBlocks(`أ<lead></lead>ب<lead>null</lead>ج${block({})}د`, '§')).toBe('أبجد')
  })

  it('leaves a block that was never closed where it is', () => {
    expect(maskLeadBlocks('قبل <lead>{"service":', '§')).toBe('قبل <lead>{"service":')
  })
})

describe('parseLeadBlock — the "said yes" flag', () => {
  it('is true only for a plain true', () => {
    expect(parseLeadBlock(block({ ...LEAD, ready: true }))).toEqual({ lead: LEAD, ready: true })
    expect(parseLeadBlock(block({ ...LEAD, ready: 'true' }))?.ready).toBe(true)
    for (const ready of [false, 'yes', 1, null, undefined]) {
      expect(parseLeadBlock(block({ ...LEAD, ready }))).toEqual({ lead: LEAD, ready: false })
    }
  })

  it('is not part of the lead that is passed on', () => {
    expect(parseLeadBlock(block({ ...LEAD, ready: true }))?.lead).not.toHaveProperty('ready')
  })

  it('a yes with nothing else collected still gives a lead, so customer_ready never travels without one', () => {
    expect(parseLeadBlock(block({ ready: true }))).toEqual({
      lead: { service: 'other', details: [], quoted_price_sar: null, customer_name: null, area: null, preferred_date: null },
      ready: true,
    })
    expect(parseLeadBlock(block({ ready: false }))).toBeNull()
  })
})
