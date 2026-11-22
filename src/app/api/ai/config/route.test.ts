import { beforeEach, describe, expect, it, vi } from 'vitest'

// The AI settings endpoint, as far as the voice-reply speed goes
// (`voice_reply_speed`, migration 042). No provider, database or
// encryption call here is real.

type Row = Record<string, unknown>
type DbError = { code: string; message: string }

const VOICE_COLUMNS =
  'voice_transcription_enabled, voice_reply_enabled, gemini_api_key, elevenlabs_api_key, elevenlabs_voice_id'

const h = vi.hoisted(() => ({
  validateAiCredentials: vi.fn(),
  embedTexts: vi.fn(),
  validateGeminiKey: vi.fn(),
  validateElevenLabsVoice: vi.fn(),
  db: {
    /** The account's `ai_configs` row; null = nothing saved yet. */
    row: null as Record<string, unknown> | null,
    /** Error for the read of just `voice_reply_speed` (column missing). */
    speedError: null as { code: string; message: string } | null,
    /** Error for the update / insert. */
    writeError: null as { code: string; message: string } | null,
    selects: [] as string[],
    updates: [] as Record<string, unknown>[],
    inserts: [] as Record<string, unknown>[],
  },
}))

/** Answers each read by the columns it asks for, like the real table. */
const supabase = {
  from: (table: string) => ({
    select: (columns: string) => {
      h.db.selects.push(`${table}: ${columns}`)
      const chain = {
        eq: () => chain,
        maybeSingle: async (): Promise<{ data: Row | null; error: DbError | null }> => {
          if (table !== 'ai_configs') return { data: null, error: null }
          if (columns === 'voice_reply_speed' && h.db.speedError) {
            return { data: null, error: h.db.speedError }
          }
          if (!h.db.row) return { data: null, error: null }
          const picked = Object.fromEntries(
            columns.split(', ').map((c) => [c, h.db.row![c] ?? null]),
          )
          return { data: picked, error: null }
        },
      }
      return chain
    },
    update: (payload: Row) => ({
      eq: async () => {
        h.db.updates.push(payload)
        return { error: h.db.writeError }
      },
    }),
    insert: async (payload: Row) => {
      h.db.inserts.push(payload)
      return { error: h.db.writeError }
    },
  }),
}

vi.mock('@/lib/auth/account', () => ({
  getCurrentAccount: async () => ({ supabase, accountId: 'acct-1', userId: 'user-1' }),
  requireRole: async () => ({ supabase, accountId: 'acct-1', userId: 'user-1' }),
  toErrorResponse: (err: unknown) =>
    Response.json({ error: String(err) }, { status: 500 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rate limited' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}))
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}))
vi.mock('@/lib/ai/validate', () => ({ validateAiCredentials: h.validateAiCredentials }))
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts: h.embedTexts }))
vi.mock('@/lib/ai/providers/gemini', () => ({ validateGeminiKey: h.validateGeminiKey }))
vi.mock('@/lib/ai/providers/elevenlabs', () => ({
  validateElevenLabsVoice: h.validateElevenLabsVoice,
}))

import { GET, POST } from './route'

/** An account that is set up, with voice replies on, speaking at 0.9. */
const SAVED: Row = {
  id: 'cfg-1',
  provider: 'openai',
  model: 'gpt-x',
  api_key: 'enc:sk-test',
  system_prompt: 'Be brief.',
  is_active: true,
  auto_reply_enabled: true,
  auto_reply_max_per_conversation: 30,
  handoff_agent_id: null,
  embeddings_api_key: null,
  auto_reply_test_numbers: ['966500000000'],
  voice_transcription_enabled: true,
  voice_reply_enabled: true,
  gemini_api_key: 'enc:gemini',
  elevenlabs_api_key: 'enc:eleven',
  elevenlabs_voice_id: 'voice-1',
  voice_reply_speed: 0.9,
}

/** What a save that only edits the script sends: no voice field at all. */
const SCRIPT_ONLY = {
  provider: 'openai',
  model: 'gpt-x',
  system_prompt: 'A new script.',
  is_active: true,
  auto_reply_enabled: true,
  auto_reply_max_per_conversation: 30,
}

const post = (body: unknown) =>
  POST(new Request('http://test/api/ai/config', { method: 'POST', body: JSON.stringify(body) }))
const json = async (res: Response) => (await res.json()) as Record<string, unknown>

const SPEED_COLUMN_MISSING: [string, DbError][] = [
  [
    'the REST layer does not know the column',
    { code: 'PGRST204', message: "Could not find the 'voice_reply_speed' column of 'ai_configs' in the schema cache" },
  ],
  ['Postgres does not know the column', { code: '42703', message: 'column ai_configs.voice_reply_speed does not exist' }],
]

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'error').mockImplementation(() => {})
  h.db.row = { ...SAVED }
  h.db.speedError = null
  h.db.writeError = null
  h.db.selects = []
  h.db.updates = []
  h.db.inserts = []
})

describe('POST /api/ai/config — voice speed', () => {
  it('saves the speed it is sent', async () => {
    const res = await post({ ...SCRIPT_ONLY, voice_reply_speed: 1.08 })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({ success: true })
    expect(h.db.updates).toHaveLength(1)
    expect(h.db.updates[0]).toMatchObject({ voice_reply_speed: 1.08, system_prompt: 'A new script.' })
    expect(h.db.inserts).toEqual([])
  })

  it.each([
    [5, 1.2],
    [1.21, 1.2],
    [0.1, 0.7],
    [0, 0.7],
    [-1, 0.7],
    [1.0849, 1.08],
    [0.7, 0.7],
    [1.2, 1.2],
  ])('brings %s inside the range and saves %s', async (sent, saved) => {
    expect((await post({ ...SCRIPT_ONLY, voice_reply_speed: sent })).status).toBe(200)
    expect(h.db.updates[0].voice_reply_speed).toBe(saved)
  })

  it.each([
    ['a string', '1.1'],
    ['null', null],
    ['true', true],
    ['an object', {}],
    ['a list', []],
    ['a list holding a number', [1.1]],
  ])('refuses %s and saves nothing', async (_name, value) => {
    const res = await post({ ...SCRIPT_ONLY, voice_reply_speed: value })
    expect(res.status).toBe(400)
    expect((await json(res)).error).toBe(
      'Voice speed must be a number from 0.7 to 1.2. Nothing was saved.',
    )
    expect(h.db.updates).toEqual([])
    expect(h.db.inserts).toEqual([])
  })

  it('leaves the speed alone when a save does not mention it (a script edit)', async () => {
    h.db.row = { ...SAVED, voice_reply_speed: 1.08 }
    expect((await post(SCRIPT_ONLY)).status).toBe(200)
    expect(h.db.updates).toHaveLength(1)
    expect(h.db.updates[0]).not.toHaveProperty('voice_reply_speed')
    // Nor any other voice setting: an absent field is "unchanged".
    expect(Object.keys(h.db.updates[0]).sort()).toEqual([
      'auto_reply_enabled',
      'auto_reply_max_per_conversation',
      'is_active',
      'model',
      'provider',
      'system_prompt',
    ])
  })

  it('leaves the speed alone when the other voice fields are sent without it', async () => {
    h.db.row = { ...SAVED, voice_reply_speed: 1.08 }
    const res = await post({
      ...SCRIPT_ONLY,
      voice_transcription_enabled: true,
      voice_reply_enabled: true,
      elevenlabs_voice_id: 'voice-1',
    })
    expect(res.status).toBe(200)
    expect(h.db.updates[0]).toMatchObject({ voice_reply_enabled: true, elevenlabs_voice_id: 'voice-1' })
    expect(h.db.updates[0]).not.toHaveProperty('voice_reply_speed')
  })

  it('saves the speed by itself, without touching or re-checking the other voice settings', async () => {
    const res = await post({ ...SCRIPT_ONLY, voice_reply_speed: 1.1 })
    expect(res.status).toBe(200)
    expect(h.db.updates[0]).toMatchObject({ voice_reply_speed: 1.1 })
    for (const field of VOICE_COLUMNS.split(', ')) {
      expect(h.db.updates[0]).not.toHaveProperty(field)
    }
    expect(h.db.selects).not.toContain(`ai_configs: ${VOICE_COLUMNS}`)
    expect(h.validateElevenLabsVoice).not.toHaveBeenCalled()
    expect(h.validateGeminiKey).not.toHaveBeenCalled()
    // An unchanged model and key are not re-checked with the provider either.
    expect(h.validateAiCredentials).not.toHaveBeenCalled()
  })

  it('saves the speed together with the other voice fields', async () => {
    const res = await post({
      ...SCRIPT_ONLY,
      voice_transcription_enabled: true,
      voice_reply_enabled: true,
      elevenlabs_voice_id: 'voice-1',
      voice_reply_speed: 1.08,
    })
    expect(res.status).toBe(200)
    expect(h.db.updates[0]).toMatchObject({
      voice_transcription_enabled: true,
      voice_reply_enabled: true,
      elevenlabs_voice_id: 'voice-1',
      voice_reply_speed: 1.08,
    })
  })

  it('checks the speed before anything else is validated or written', async () => {
    const res = await post({
      ...SCRIPT_ONLY,
      model: 'another-model', // would otherwise be checked with the provider
      elevenlabs_api_key: 'new-key',
      elevenlabs_voice_id: 'voice-2',
      voice_reply_speed: 'fast',
    })
    expect(res.status).toBe(400)
    expect(h.validateAiCredentials).not.toHaveBeenCalled()
    expect(h.validateElevenLabsVoice).not.toHaveBeenCalled()
    expect(h.db.updates).toEqual([])
  })

  it('goes in with the first save of a new account', async () => {
    h.db.row = null
    const res = await post({ ...SCRIPT_ONLY, api_key: 'sk-new', voice_reply_speed: 3 })
    expect(res.status).toBe(200)
    expect(h.db.updates).toEqual([])
    expect(h.db.inserts).toHaveLength(1)
    expect(h.db.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      api_key: 'enc:sk-new',
      voice_reply_speed: 1.2,
    })
  })

  it('a first save without a speed leaves it to the database default', async () => {
    h.db.row = null
    expect((await post({ ...SCRIPT_ONLY, api_key: 'sk-new' })).status).toBe(200)
    expect(h.db.inserts[0]).not.toHaveProperty('voice_reply_speed')
  })

  describe('on a database without migration 042', () => {
    it.each(SPEED_COLUMN_MISSING)('says so when a speed was sent (%s)', async (_name, error) => {
      h.db.writeError = error
      const res = await post({ ...SCRIPT_ONLY, voice_reply_speed: 1.08 })
      expect(res.status).toBe(400)
      expect((await json(res)).error).toBe(
        'Voice speed needs database migration 042 (ai_configs voice_reply_speed). Nothing was saved.',
      )
    })

    it.each(SPEED_COLUMN_MISSING)('says so on a first save too (%s)', async (_name, error) => {
      h.db.row = null
      h.db.writeError = error
      const res = await post({ ...SCRIPT_ONLY, api_key: 'sk-new', voice_reply_speed: 1.08 })
      expect(res.status).toBe(400)
      expect((await json(res)).error).toContain('migration 042')
    })

    it.each(SPEED_COLUMN_MISSING)('does not blame 042 when no speed was sent (%s)', async (_name, error) => {
      h.db.writeError = error
      const res = await post(SCRIPT_ONLY)
      expect(res.status).toBe(500)
      expect((await json(res)).error).not.toContain('042')
    })

    it('does not blame 042 for another missing column', async () => {
      h.db.writeError = { code: '42703', message: 'column ai_configs.something_else does not exist' }
      const res = await post({ ...SCRIPT_ONLY, voice_reply_speed: 1.08 })
      expect((await json(res)).error).not.toContain('042')
    })

    it('still saves everything else when the form does not send the speed', async () => {
      // The page hides the control (`voice_speed_available: false`) and
      // leaves the field out, so the write never names the column.
      expect((await post(SCRIPT_ONLY)).status).toBe(200)
      expect(h.db.updates[0]).not.toHaveProperty('voice_reply_speed')
    })
  })
})

describe('GET /api/ai/config — voice speed', () => {
  it('returns the stored speed', async () => {
    h.db.row = { ...SAVED, voice_reply_speed: 1.08 }
    const body = await json(await GET())
    expect(body).toMatchObject({
      configured: true,
      voice_available: true,
      voice_speed_available: true,
      voice_reply_speed: 1.08,
    })
  })

  it('reads the speed on its own, apart from the other voice settings', async () => {
    await GET()
    expect(h.db.selects).toContain('ai_configs: voice_reply_speed')
    expect(h.db.selects).toContain(`ai_configs: ${VOICE_COLUMNS}`)
  })

  it('returns a number when the database hands the numeric back as text', async () => {
    h.db.row = { ...SAVED, voice_reply_speed: '1.08' }
    expect((await json(await GET())).voice_reply_speed).toBe(1.08)
  })

  it('returns a speed inside the range whatever is stored', async () => {
    h.db.row = { ...SAVED, voice_reply_speed: 9 }
    expect((await json(await GET())).voice_reply_speed).toBe(1.2)
  })

  it('returns the default, 0.9, before anything is saved', async () => {
    h.db.row = null
    expect(await json(await GET())).toMatchObject({
      configured: false,
      voice_speed_available: true,
      voice_reply_speed: 0.9,
    })
  })

  it('hides the control, and nothing else, on a database without migration 042', async () => {
    h.db.speedError = { code: '42703', message: 'column ai_configs.voice_reply_speed does not exist' }
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await json(res)).toMatchObject({
      configured: true,
      voice_speed_available: false,
      voice_reply_speed: 0.9,
      // The rest of the voice card is unaffected.
      voice_available: true,
      voice_transcription_enabled: true,
      voice_reply_enabled: true,
      elevenlabs_voice_id: 'voice-1',
      has_elevenlabs_key: true,
    })
  })

  it('never returns a key', async () => {
    const text = JSON.stringify(await json(await GET()))
    expect(text).not.toContain('enc:')
  })
})
