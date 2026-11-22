import { describe, expect, it } from 'vitest'
import {
  VOICE_SPEED_DEFAULT,
  VOICE_SPEED_MAX,
  VOICE_SPEED_MIN,
  storedVoiceSpeed,
  toVoiceSpeed,
} from './voice-speed'

describe('the range', () => {
  it("is ElevenLabs' 0.7 to 1.2, and the default is what every account spoke at before", () => {
    expect([VOICE_SPEED_MIN, VOICE_SPEED_MAX, VOICE_SPEED_DEFAULT]).toEqual([0.7, 1.2, 0.9])
  })
})

describe('toVoiceSpeed', () => {
  it.each([0.7, 0.9, 1, 1.08, 1.2])('keeps %s, which is inside the range', (speed) => {
    expect(toVoiceSpeed(speed)).toBe(speed)
  })

  it.each([
    [0.69, 0.7],
    [0.1, 0.7],
    [0, 0.7],
    [-3, 0.7],
    [1.21, 1.2],
    [5, 1.2],
    [Number.MAX_VALUE, 1.2],
  ])('brings %s inside the range, as %s', (sent, kept) => {
    expect(toVoiceSpeed(sent)).toBe(kept)
  })

  it('rounds to two decimals', () => {
    expect(toVoiceSpeed(1.0849)).toBe(1.08)
    expect(toVoiceSpeed(1.085)).toBeCloseTo(1.09, 5)
    expect(toVoiceSpeed(0.7000001)).toBe(0.7)
    // Whichever way a half lands, the result is still a valid speed.
    const half = toVoiceSpeed(0.905)!
    expect(half).toBeGreaterThanOrEqual(0.9)
    expect(half).toBeLessThanOrEqual(0.91)
    expect(String(half).length).toBeLessThanOrEqual(4)
  })

  it.each([
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['NaN', NaN],
    ['a numeric string', '1.1'],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['an object', {}],
    ['a list', []],
  ])('is null for %s: not a number someone can have meant', (_name, value) => {
    expect(toVoiceSpeed(value)).toBeNull()
  })
})

describe('storedVoiceSpeed', () => {
  it('keeps a stored number, inside the range', () => {
    expect(storedVoiceSpeed(1.08)).toBe(1.08)
    expect(storedVoiceSpeed(9)).toBe(1.2)
    expect(storedVoiceSpeed(0.2)).toBe(0.7)
  })

  it('reads a numeric the database handed back as text', () => {
    expect(storedVoiceSpeed('1.08')).toBe(1.08)
    expect(storedVoiceSpeed('0.90')).toBe(0.9)
    expect(storedVoiceSpeed(' 1.1 ')).toBe(1.1)
    expect(storedVoiceSpeed('7')).toBe(1.2)
  })

  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['text that is not a number', 'abc'],
    ['null', null],
    ['undefined', undefined],
    ['true', true],
    ['an object', {}],
  ])('is the default for %s', (_name, value) => {
    expect(storedVoiceSpeed(value)).toBe(0.9)
  })
})
