import { describe, it, expect } from 'vitest';
import { renderTemplateBody } from './template-send-builder';

describe('renderTemplateBody', () => {
  it('substitutes positional variables', () => {
    expect(
      renderTemplateBody('Hi {{1}}, booking {{2}} is confirmed.', [
        'Sara',
        '4821',
      ])
    ).toBe('Hi Sara, booking 4821 is confirmed.');
  });

  it('leaves an unfilled index visible rather than blanking it', () => {
    expect(renderTemplateBody('Hi {{1}}, ref {{2}}', ['Sara'])).toBe(
      'Hi Sara, ref {{2}}'
    );
  });

  it('repeats a variable used more than once', () => {
    expect(renderTemplateBody('{{1}} — {{1}}', ['x'])).toBe('x — x');
  });

  it('passes a body with no variables through unchanged', () => {
    expect(renderTemplateBody('Your crew has arrived.', [])).toBe(
      'Your crew has arrived.'
    );
  });

  // The regression this whole change exists for: an API caller sends only
  // template params, so the persisted body must come from the template row.
  // A blank result here is what drew empty bubbles in the inbox.
  it('produces a non-empty body from params alone', () => {
    const rendered = renderTemplateBody('مرحباً {{1}}، حجزك رقم {{2}}', [
      'سارة',
      '4821',
    ]);
    expect(rendered).not.toBe('');
    expect(rendered).toContain('سارة');
  });
});
