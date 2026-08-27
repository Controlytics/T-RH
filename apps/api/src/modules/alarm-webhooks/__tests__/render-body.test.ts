import { describe, it, expect } from 'vitest';
import { renderWebhookBody } from '../render-body.js';

describe('renderWebhookBody', () => {
  it('substitutes plain values', () => {
    const out = renderWebhookBody('{"i":"${instrument}"}', { instrument: 'DEMO-TH-361' }, 'application/json');
    expect(out).toBe('{"i":"DEMO-TH-361"}');
    expect(JSON.parse(out).i).toBe('DEMO-TH-361');
  });

  // The whole reason this module exists instead of reusing resolveTemplate().
  it('JSON-escapes a value containing quotes and ampersands', () => {
    const out = renderWebhookBody('{"i":"${instrument}"}', { instrument: 'Chiller "A" & B' }, 'application/json');
    expect(out).not.toContain('&quot;');
    expect(out).not.toContain('&amp;');
    expect(JSON.parse(out).i).toBe('Chiller "A" & B');
  });

  it('JSON-escapes backslashes and newlines', () => {
    const out = renderWebhookBody('{"r":"${reason}"}', { reason: 'line1\nline2 C:\\temp' }, 'application/json');
    expect(JSON.parse(out).r).toBe('line1\nline2 C:\\temp');
  });

  it('inserts raw for a non-JSON content type', () => {
    const out = renderWebhookBody('msg=${instrument}', { instrument: 'A "B" & C' }, 'text/plain');
    expect(out).toBe('msg=A "B" & C');
  });

  // A typo must be visible in the delivery log, not silently rendered as "".
  it('leaves an unknown placeholder literal', () => {
    const out = renderWebhookBody('{"x":"${nope}"}', { instrument: 'A' }, 'application/json');
    expect(out).toBe('{"x":"${nope}"}');
  });

  it('substitutes every occurrence of a repeated placeholder', () => {
    const out = renderWebhookBody('${a}|${a}', { a: 'x' }, 'text/plain');
    expect(out).toBe('x|x');
  });

  it('treats an application/json content type with a charset suffix as JSON', () => {
    const out = renderWebhookBody('{"i":"${i}"}', { i: 'a"b' }, 'application/json; charset=utf-8');
    expect(JSON.parse(out).i).toBe('a"b');
  });
});
