import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Performance audit 2026-11-17, G1-01: an INTERVAL Data Report asks the server for
 * the readings it prints (`/telemetry-report-rows`, the first reading of each slot)
 * instead of every reading of the period; a RAW report still asks for every reading.
 * The rows are built by the same `scheduleRows` either way.
 */
const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

const { fetchDataReportRows } = await import('../data-report-fetch');

const SAMPLED = { history: [], historyTotal: 40, summaries: { t: { min: 20, max: 22 } } };
const SLOT_READINGS = {
  history: [
    { key: 't', value: 21.5, ts: '2026-11-17T10:30:00.000Z' },
    { key: 't', value: 21.0, ts: '2026-11-17T10:00:00.000Z' },
  ],
  historyTotal: 40,
};
const input = (intervalMs: number | null) => ({
  instrumentId: 'i-1', from: '2026-11-17T10:00:00.000Z', to: '2026-11-17T11:00:00.000Z', intervalMs, slotKeys: ['t', 'h'],
});

beforeEach(() => {
  get.mockReset();
  get.mockImplementation(async (url: string) => (url.includes('points=') ? SAMPLED : SLOT_READINGS));
});

describe('fetchDataReportRows', () => {
  it('an interval report asks for the slot readings only — with its interval and keys', async () => {
    const out = await fetchDataReportRows(input(30 * 60_000));
    const urls = get.mock.calls.map((c) => String(c[0]));
    expect(urls).toHaveLength(2);
    const rows = new URL(urls[1]!, 'https://x');
    expect(rows.pathname).toBe('/api/instruments/i-1/telemetry-report-rows');
    expect(rows.searchParams.get('intervalMs')).toBe(String(30 * 60_000));
    expect(rows.searchParams.get('keys')).toBe('t,h');
    expect(urls.some((u) => u.includes('limit='))).toBe(false);
    // The schedule is built in the browser as before: 10:00 → 11:00 at 30 min is three
    // slots, the last one with no reading (NA), newest first.
    expect(out.rows.map((r) => [r.ts, r.row?.values.t ?? null])).toEqual([
      ['2026-11-17T11:00:00.000Z', null],
      ['2026-11-17T10:30:00.000Z', 21.5],
      ['2026-11-17T10:00:00.000Z', 21],
    ]);
    expect(out.summaries).toEqual(SAMPLED.summaries);
  });

  it('a RAW report still asks for every reading of the period', async () => {
    await fetchDataReportRows(input(null));
    const urls = get.mock.calls.map((c) => String(c[0]));
    expect(urls[1]).toContain('/api/instruments/i-1/telemetry?');
    expect(urls[1]).toContain('limit=40');
    expect(urls.some((u) => u.includes('telemetry-report-rows'))).toBe(false);
  });

  it('the sampled call asks for 2 points — it is made for the true total and the summaries only (R1 retest)', async () => {
    // Its rows were ~1 MB per instrument at 5,000 a key and the report threw them away.
    // The total and the summaries are the server's SQL over every reading, whatever
    // `points` is — so both paths still get them from this call.
    for (const intervalMs of [30 * 60_000, null]) {
      get.mockClear();
      const out = await fetchDataReportRows(input(intervalMs));
      const sampledUrl = new URL(String(get.mock.calls[0]![0]), 'https://x');
      expect(sampledUrl.pathname).toBe('/api/instruments/i-1/telemetry');
      expect(sampledUrl.searchParams.get('points')).toBe('2');
      expect(out.summaries).toEqual(SAMPLED.summaries);
    }
    // RAW sizes its whole-period read by the TOTAL (40), not by the sampled rows (0).
    expect(String(get.mock.calls[1]![0])).toContain('limit=40');
  });

  it('asks nothing more when the period holds no reading', async () => {
    get.mockImplementation(async () => ({ history: [], historyTotal: 0, summaries: {} }));
    const out = await fetchDataReportRows(input(30 * 60_000));
    expect(get).toHaveBeenCalledTimes(1);
    expect(out.rows).toEqual([]);
  });
});
