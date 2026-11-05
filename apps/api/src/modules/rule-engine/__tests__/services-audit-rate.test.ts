import { describe, it, expect } from 'vitest';

/**
 * The audit-rate warning (review A I5, ruled 2026-11-05): the rule engine counts the
 * audit rows it commits and SAYS so, at most once a minute, when chains write more
 * than 600 of them within a minute. It never throttles or drops a row — the meter has
 * no way to: it only counts and warns. No database: a pure counter on an injected clock.
 */
const { createAuditRateMeter, RULE_AUDIT_WARN_PER_MINUTE } = await import('../services.js');

function meter(start = 1_000_000) {
  let t = start;
  const warnings: [number, number][] = [];
  const m = createAuditRateMeter((rows, limit) => warnings.push([rows, limit]), { now: () => t });
  return { m, warnings, advance: (ms: number) => { t += ms; } };
}

describe('the audit-rate meter', () => {
  it('600 rows in a minute: no warning; the 601st: ONE warning naming the count and the limit', () => {
    expect(RULE_AUDIT_WARN_PER_MINUTE).toBe(600);
    const { m, warnings } = meter();
    for (let i = 0; i < 600; i++) m.note(1);
    expect(warnings).toEqual([]);
    m.note(1);
    expect(warnings).toEqual([[601, 600]]);
  });

  it('900 in the same minute (in batches): still ONE warning — once a minute', () => {
    const { m, warnings, advance } = meter();
    m.note(400);
    advance(30_000);
    m.note(300);
    advance(29_000);
    m.note(200);
    expect(warnings).toEqual([[700, 600]]);
  });

  it('the next minute is counted afresh and warns again when it passes the limit', () => {
    const { m, warnings, advance } = meter();
    m.note(601);
    advance(60_000);
    m.note(600);
    expect(warnings).toHaveLength(1);
    m.note(1);
    expect(warnings).toEqual([[601, 600], [601, 600]]);
  });

  it('zero / negative / NaN rows are no rows: they neither count nor spoil the count — the 601st real row still warns, at 601', () => {
    const { m, warnings } = meter();
    m.note(0);
    m.note(-5);
    m.note(Number.NaN);
    m.note(600);
    expect(warnings).toEqual([]);
    m.note(1);
    expect(warnings).toEqual([[601, 600]]);
  });
});
