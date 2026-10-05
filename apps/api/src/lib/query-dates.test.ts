import { describe, it, expect } from 'vitest';
import { parseDateBound, parseDateRange } from './query-dates.js';

// Audit 2026-10-03, API-12: the one reader of startDate/endDate on list routes.
describe('parseDateBound', () => {
  it('accepts an ISO instant unchanged', () => {
    const r = parseDateBound('2026-10-05T10:30:00.000Z', 'end');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date.toISOString()).toBe('2026-10-05T10:30:00.000Z');
  });

  it('refuses text that is not a date', () => {
    expect(parseDateBound('yesterday', 'start').ok).toBe(false);
    expect(parseDateBound('', 'start').ok).toBe(false);
    expect(parseDateBound('   ', 'end').ok).toBe(false);
  });

  it('a date-only END bound is the end of that UTC day', () => {
    const r = parseDateBound('2026-10-05', 'end');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date.toISOString()).toBe('2026-10-05T23:59:59.999Z');
  });

  it('a date-only START bound stays at the start of that UTC day', () => {
    const r = parseDateBound('2026-10-05', 'start');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.date.toISOString()).toBe('2026-10-05T00:00:00.000Z');
  });
});

describe('parseDateRange', () => {
  it('reports each bad field by name', () => {
    const r = parseDateRange('nope', 'also-nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(['endDate', 'startDate']);
  });

  it('refuses a reversed range', () => {
    const r = parseDateRange('2026-10-06', '2026-10-05');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.endDate?.[0]).toMatch(/before/);
  });

  it('a one-day pair spans the whole day, not one instant', () => {
    const r = parseDateRange('2026-10-05', '2026-10-05');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.gte?.toISOString()).toBe('2026-10-05T00:00:00.000Z');
      expect(r.lte?.toISOString()).toBe('2026-10-05T23:59:59.999Z');
    }
  });

  it('either bound may be absent', () => {
    const r = parseDateRange(undefined, '2026-10-05T00:00:00Z');
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.gte).toBeUndefined(); expect(r.lte).toBeInstanceOf(Date); }
  });
});
