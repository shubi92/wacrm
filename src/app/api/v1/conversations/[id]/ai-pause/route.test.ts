import { beforeEach, describe, expect, it, vi } from 'vitest';

import { API_PAUSE_NOTE, replyCapSummary, isReplyCapSummary } from '@/lib/ai/handoff';

type Row = {
  id: string;
  account_id: string;
  ai_autoreply_disabled: boolean;
  ai_handoff_summary: string | null;
};

const h = vi.hoisted(() => ({
  requireApiKey: vi.fn(),
  rows: [] as Row[],
  updates: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.requireApiKey }));

// A conversations table that honours every `.eq()` filter, so a row in
// another account is invisible to both the read and the write.
function fakeDb() {
  return {
    from: () => {
      const filters: Record<string, unknown> = {};
      let payload: Record<string, unknown> | null = null;
      const matches = () =>
        h.rows.filter((r) =>
          Object.entries(filters).every(([k, v]) => r[k as keyof Row] === v)
        );
      const q = {
        select: () => q,
        update: (p: Record<string, unknown>) => ((payload = p), q),
        eq: (col: string, val: unknown) => ((filters[col] = val), q),
        maybeSingle: async () => ({ data: matches()[0] ?? null, error: null }),
        then: (resolve: (v: { error: null }) => void) => {
          for (const r of matches()) Object.assign(r, payload);
          if (payload) h.updates.push(payload);
          resolve({ error: null });
        },
      };
      return q;
    },
  };
}

import { POST } from './route';

const call = (id: string) =>
  POST(
    new Request(`http://localhost/api/v1/conversations/${id}/ai-pause`, {
      method: 'POST',
      headers: { authorization: 'Bearer wacrm_live_x' },
    }),
    { params: Promise.resolve({ id }) }
  );

const row = (over: Partial<Row> = {}): Row => ({
  id: 'conv-1',
  account_id: 'account-1',
  ai_autoreply_disabled: false,
  ai_handoff_summary: null,
  ...over,
});

beforeEach(() => {
  h.rows = [];
  h.updates = [];
  h.requireApiKey.mockReset();
  h.requireApiKey.mockResolvedValue({ supabase: fakeDb(), accountId: 'account-1' });
});

describe('POST /api/v1/conversations/{id}/ai-pause', () => {
  it('pauses the bot on a chat it was answering', async () => {
    h.rows = [row()];

    const res = await call('conv-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      data: { id: 'conv-1', ai_paused: true, already_paused: false },
    });
    expect(h.requireApiKey).toHaveBeenCalledWith(expect.anything(), 'messages:send');
    expect(h.rows[0]).toMatchObject({
      ai_autoreply_disabled: true,
      ai_handoff_summary: API_PAUSE_NOTE,
    });
  });

  it('is idempotent and keeps the note of a pause someone already set', async () => {
    const note = '🤖 AI agent handed off after 2 replies. Customer is ready: sofa cleaning.';
    h.rows = [row({ ai_autoreply_disabled: true, ai_handoff_summary: note })];

    const res = await call('conv-1');

    expect(res.status).toBe(200);
    expect((await res.json()).data.already_paused).toBe(true);
    expect(h.updates).toEqual([]);
    expect(h.rows[0].ai_handoff_summary).toBe(note);
  });

  it('replaces the reply cap pause, which the bot would lift by itself after a quiet day', async () => {
    h.rows = [row({ ai_autoreply_disabled: true, ai_handoff_summary: replyCapSummary(8) })];

    const res = await call('conv-1');

    expect(res.status).toBe(200);
    expect(h.rows[0].ai_handoff_summary).toBe(API_PAUSE_NOTE);
    expect(isReplyCapSummary(h.rows[0].ai_handoff_summary)).toBe(false);
  });

  it("answers 404 for another account's conversation and leaves it alone", async () => {
    h.rows = [row({ account_id: 'account-2' })];

    const res = await call('conv-1');

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('not_found');
    expect(h.updates).toEqual([]);
    expect(h.rows[0].ai_autoreply_disabled).toBe(false);
  });
});
