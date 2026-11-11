import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from './defaults'
import { LEAD_SERVICES } from './lead'

const USER_PROMPT = 'We are Al-Waha home services in Riyadh.'

describe('buildSystemPrompt — ready customers', () => {
  it('teaches the <lead> block and lists every service in auto-reply mode', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toContain('<lead>')
    for (const service of LEAD_SERVICES) expect(prompt).toContain(service)
  })

  it('does not mention the <lead> block in draft mode', () => {
    const prompt = buildSystemPrompt({ userPrompt: USER_PROMPT, mode: 'draft' })
    expect(prompt).not.toContain('<lead>')
    expect(prompt).not.toContain('Passing on what you collected')
  })

  it("puts the account's own instructions after the lead paragraph", () => {
    const prompt = buildSystemPrompt({ userPrompt: USER_PROMPT, mode: 'auto_reply' })
    const ready = prompt.indexOf('Passing on what you collected')
    expect(ready).toBeGreaterThan(-1)
    expect(prompt.lastIndexOf('<lead>')).toBeGreaterThan(ready)
    expect(prompt.indexOf(USER_PROMPT)).toBeGreaterThan(prompt.lastIndexOf('<lead>'))
  })

  it('carries only the mechanism, no per-service question script', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).not.toMatch(/split/i)
    expect(prompt).not.toMatch(/btu/i)
  })
})

describe('buildSystemPrompt — after Resume AI', () => {
  it('puts the "switched back on" rule after the account\'s own instructions, in auto-reply only', () => {
    const prompt = buildSystemPrompt({ userPrompt: 'ACCOUNT RULES', mode: 'auto_reply', resumed: true })
    expect(prompt.indexOf('switched you back on')).toBeGreaterThan(prompt.indexOf('ACCOUNT RULES'))
    expect(buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })).not.toContain('switched you back on')
    expect(buildSystemPrompt({ userPrompt: null, mode: 'draft', resumed: true })).not.toContain('switched you back on')
  })
})

describe('buildSystemPrompt — lead block on any handoff', () => {
  it('asks for the block whenever it hands off with something collected, with a separate "ready" flag', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    expect(prompt).toContain('Whenever you hand off')
    expect(prompt).toContain('"ready" (true or false')
    expect(prompt).toContain('in every other handoff "ready" is false')
  })
})
