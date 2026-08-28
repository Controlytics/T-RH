import { describe, it, expect } from 'vitest';
import { limitsAgree, shapeBuckets, type AggregateRow } from '../telemetry-aggregate.js';

/**
 * The pure halves of the dashboard's aggregate trend. The SQL lives beside them;
 * these are the rules, and the rules are what can be wrong.
 */
describe('limitsAgree', () => {
  it('agrees when every instrument resolves to the same bound', () => {
    expect(limitsAgree([{ min: 2, max: 8 }, { min: 2, max: 8 }])).toEqual({ min: 2, max: 8 });
  });

  it('does NOT agree when one differs', () => {
    // Drawing the first instrument's limits across the rest would be a false
    // claim about every other instrument on the chart, and it is the easy thing
    // to do by accident.
    expect(limitsAgree([{ min: 2, max: 8 }, { min: 2, max: 25 }])).toBeNull();
  });

  it('does NOT agree when one instrument has no limits at all', () => {
    // "One of them is unbounded" is MIXED, not agreement. A line drawn here would
    // assert a bound for an instrument that has none.
    expect(limitsAgree([{ min: 2, max: 8 }, { min: null, max: null }])).toBeNull();
  });

  it('agrees on a half-bounded selection when the half matches', () => {
    // A real case: a high limit set, a low limit deliberately not.
    expect(limitsAgree([{ min: null, max: 8 }, { min: null, max: 8 }])).toEqual({ min: null, max: 8 });
  });

  it('agrees for a single instrument', () => {
    expect(limitsAgree([{ min: 2, max: 8 }])).toEqual({ min: 2, max: 8 });
  });

  it('returns null for an empty selection rather than a bound', () => {
    expect(limitsAgree([])).toBeNull();
  });

  it('treats 0 as a REAL bound, not as absent', () => {
    // Recorded elsewhere in this codebase and worth pinning here too: a limit of
    // zero is a bound someone set, and a falsy check would drop it.
    expect(limitsAgree([{ min: 0, max: 8 }, { min: 0, max: 8 }])).toEqual({ min: 0, max: 8 });
    expect(limitsAgree([{ min: 0, max: 8 }, { min: null, max: 8 }])).toBeNull();
  });
});

describe('shapeBuckets', () => {
  const rows = [
    { ts: new Date('2026-08-28T10:00:00Z'), slot: 'temperature', min: 2, avg: 4, max: 6, instrumentCount: 3n },
    { ts: new Date('2026-08-28T10:05:00Z'), slot: 'temperature', min: 3, avg: 3.5, max: 4, instrumentCount: 2n },
    { ts: new Date('2026-08-28T10:00:00Z'), slot: 'humidity', min: 40, avg: 45, max: 50, instrumentCount: 3n },
  ] as unknown as AggregateRow[];

  it('splits rows by slot and preserves time order', () => {
    const out = shapeBuckets(rows);
    expect(out.temperature.map((p) => p.ts)).toEqual([
      '2026-08-28T10:00:00.000Z', '2026-08-28T10:05:00.000Z',
    ]);
    expect(out.humidity).toHaveLength(1);
  });

  it('carries the per-bucket instrument count as a NUMBER', () => {
    // Postgres count() comes back as BigInt through Prisma raw queries and
    // JSON.stringify throws on BigInt — a 500 at serialisation time, long after
    // the query looked fine.
    const out = shapeBuckets(rows);
    expect(out.temperature[1].instrumentCount).toBe(2);
    expect(typeof out.temperature[1].instrumentCount).toBe('number');
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it('keeps min, mean and max distinct', () => {
    const p = shapeBuckets(rows)[0 as never] ?? shapeBuckets(rows).temperature[0];
    expect([p.min, p.mean, p.max]).toEqual([2, 4, 6]);
  });

  it('returns empty arrays for both slots when there is nothing', () => {
    expect(shapeBuckets([])).toEqual({ temperature: [], humidity: [] });
  });
});
