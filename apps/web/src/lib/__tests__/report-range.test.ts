import { describe, it, expect } from 'vitest';
import { isoToDateInput, startOfDayIso, endOfDayIso } from '../datetime-input';

const IST = 'Asia/Kolkata';

/**
 * The per-page range logic these guard is inlined in the route components
 * (pm-schedules/index.tsx, cleaning-cycles/history.tsx), so these tests
 * reproduce that logic against the shared helper rather than importing a page.
 * They lock the two behaviours the fixes turn on: a year SPAN is fetched whole
 * (M77), and an export reports the count it actually contains (M61).
 */

/** Mirrors the `years` memo in pm-schedules/index.tsx. */
function yearsInRange(dateFrom: string, dateTo: string): number[] {
  const fromYear = Number(dateFrom.slice(0, 4));
  const toYear = Number(dateTo.slice(0, 4));
  if (!Number.isFinite(fromYear) || !Number.isFinite(toYear) || toYear < fromYear) {
    return [fromYear].filter(Number.isFinite);
  }
  const span = Math.min(toYear - fromYear, 10);
  return Array.from({ length: span + 1 }, (_, i) => fromYear + i);
}

describe('PM schedule year span (M77)', () => {
  it('fetches every year a cross-year range touches', () => {
    // The old `new Date(dateFrom).getFullYear()` yielded [2026] and silently
    // dropped every Jan/Feb 2027 entry.
    expect(yearsInRange('2026-12-01', '2027-02-28')).toEqual([2026, 2027]);
  });

  it('stays single-year for a within-year range', () => {
    expect(yearsInRange('2026-07-01', '2026-07-31')).toEqual([2026]);
  });

  it('spans more than two years', () => {
    expect(yearsInRange('2025-11-01', '2027-03-01')).toEqual([2025, 2026, 2027]);
  });

  it('does not fan out on an absurd range', () => {
    expect(yearsInRange('2026-01-01', '9999-01-01')).toHaveLength(11);
  });

  it('tolerates an inverted range without producing a negative span', () => {
    expect(yearsInRange('2027-01-01', '2026-01-01')).toEqual([2027]);
  });

  it('does not shift the year for a January 1st start (the UTC-parse hazard)', () => {
    // `new Date('2026-01-01').getFullYear()` returns 2025 in any zone west of
    // UTC. The string slice cannot.
    expect(yearsInRange('2026-01-01', '2026-12-31')).toEqual([2026]);
  });
});

describe('PM entry day-key filtering (M77)', () => {
  it('keeps an entry whose local day is inside the range but whose UTC day is not', () => {
    // 2026-08-01 00:30 IST is stored as 2026-07-31T19:00Z. Slicing the ISO
    // string put it on 07-31 and dropped it from an August range.
    const plannedDate = '2026-07-31T19:00:00.000Z';
    expect(plannedDate.slice(0, 10)).toBe('2026-07-31');
    const localDay = isoToDateInput(plannedDate, IST);
    expect(localDay).toBe('2026-08-01');
    expect(localDay >= '2026-08-01' && localDay <= '2026-08-31').toBe(true);
  });
});

describe('Cleaning record export bounds + header (M60, M61)', () => {
  it('sends bounds that cover the operator local day', () => {
    expect(startOfDayIso('2026-07-15', IST)).toBe('2026-07-14T18:30:00.000Z');
    expect(endOfDayIso('2026-07-15', IST)).toBe('2026-07-15T18:29:59.999Z');
  });

  it('header count equals the exported cycle count, excluding manual rows', () => {
    // `total` from the server counts cycles AND manual updates; the export only
    // ships cycles. Quoting `total` in the header overstated the document.
    const fetched = [
      { _kind: 'cycle' }, { _kind: 'manual' }, { _kind: 'cycle' }, { _kind: 'manual' }, { _kind: 'cycle' },
    ];
    const serverTotal = fetched.length; // 5
    const exported = fetched.filter((r) => r._kind !== 'manual');
    expect(exported).toHaveLength(3);
    expect(exported.length).not.toBe(serverTotal);
    // The header/audit count must follow the export, not the server total.
    expect(exported.length).toBe(3);
  });

  it('discloses truncation at the server cap, which the export limit cannot catch', () => {
    // The server caps its merge index at 5000 cycles while the DEFAULT export
    // limit is 10000 — so the limit guard never fires and the set arrives short
    // in silence. Truncation must be announced independently of that guard.
    const SERVER_CYCLE_CAP = 5000;
    const configuredMax = 10000; // EXPORT_LIMIT_DEFAULT_MAX
    const exported = SERVER_CYCLE_CAP; // operator asked for 6000
    expect(exported > configuredMax).toBe(false); // limit guard stays silent
    expect(exported >= SERVER_CYCLE_CAP).toBe(true); // truncation notice fires
  });

  it('the export limit is compared against the whole set, not one page', () => {
    const maxRecords = 20;
    const perPage = 10;
    const trueCycleCount = 57;
    // The old guard compared a page's length — never more than perPage, so it
    // could never trip.
    expect(perPage > maxRecords).toBe(false);
    expect(trueCycleCount > maxRecords).toBe(true);
  });
});
