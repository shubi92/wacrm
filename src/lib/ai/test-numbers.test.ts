import { describe, it, expect } from 'vitest'
import { normalizePhone, parseTestNumbers, isTestNumberAllowed } from './test-numbers'

describe('normalizePhone', () => {
  it('treats local, +966 and 00966 Saudi forms as the same number', () => {
    expect(normalizePhone('0501234567')).toBe('966501234567')
    expect(normalizePhone('+966 50 123 4567')).toBe('966501234567')
    expect(normalizePhone('00966501234567')).toBe('966501234567')
    expect(normalizePhone('966501234567')).toBe('966501234567')
  })
  it('reads Arabic-Indic and Persian digits', () => {
    expect(normalizePhone('٠٥٠١٢٣٤٥٦٧')).toBe('966501234567')
    expect(normalizePhone('۰۵۰۱۲۳۴۵۶۷')).toBe('966501234567')
  })
  it('leaves non-Saudi international numbers alone', () => {
    expect(normalizePhone('+44 7700 900123')).toBe('447700900123')
  })
})

describe('parseTestNumbers', () => {
  it('splits lines and commas (incl. Arabic comma), normalizes, dedupes', () => {
    expect(parseTestNumbers('0501234567\n+966 50 123 4567, 0559876543\n\n٠٥٤٢٨٠٠٤٠٨')).toEqual({
      ok: true,
      numbers: ['966501234567', '966559876543', '966542800408'],
    })
  })
  it('accepts an array', () => {
    expect(parseTestNumbers(['0501234567'])).toEqual({ ok: true, numbers: ['966501234567'] })
  })
  it('treats blank input as the explicit "no restriction"', () => {
    expect(parseTestNumbers('')).toEqual({ ok: true, numbers: [] })
    expect(parseTestNumbers('  \n ')).toEqual({ ok: true, numbers: [] })
    expect(parseTestNumbers([])).toEqual({ ok: true, numbers: [] })
    expect(parseTestNumbers(null)).toEqual({ ok: true, numbers: [] })
  })
  it('rejects junk instead of silently widening to "everyone"', () => {
    expect(parseTestNumbers('0501234567\nabc\n12')).toEqual({ ok: false, invalid: ['abc', '12'] })
    expect(parseTestNumbers(42)).toEqual({ ok: false, invalid: ['(unsupported value)'] })
    expect(parseTestNumbers(['0501234567', 5])).toEqual({ ok: false, invalid: ['(non-text entry)'] })
  })
})

describe('isTestNumberAllowed', () => {
  it('allows everyone when the list is empty or missing', () => {
    expect(isTestNumberAllowed('966501234567', [])).toBe(true)
    expect(isTestNumberAllowed('966501234567', null)).toBe(true)
  })
  it('allows only listed numbers when the list has entries', () => {
    const list = ['966501234567']
    expect(isTestNumberAllowed('+966501234567', list)).toBe(true)
    expect(isTestNumberAllowed('0501234567', list)).toBe(true)
    expect(isTestNumberAllowed('966559876543', list)).toBe(false)
    expect(isTestNumberAllowed(null, list)).toBe(false)
  })
})
