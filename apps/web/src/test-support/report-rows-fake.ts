/**
 * A test fake of `GET /api/instruments/:id/telemetry-report-rows` (2026-11-17,
 * performance audit G1-01, `apps/api/src/modules/instruments/report-rows.ts`):
 * per `intervalMs` slot, anchored on the period's first instant, every reading of
 * `keys` at the slot's FIRST instant, newest first; `historyTotal` = every reading
 * in the period, all keys.
 *
 * The SERVER's side of that rule is pinned against the browser's own
 * `scheduleRows` by `apps/api/src/e2e/report-rows.e2e.test.ts`; this fake only
 * hands a page what the real endpoint would, so a page test exercises the
 * interval path with the reduced row set it gets in production. A page test whose
 * fake does NOT know this endpoint (a `startsWith('/api/instruments/')` catch-all)
 * hands the report a wrong-shaped answer — it surfaced as 5 s timeouts.
 */
export interface FakeReading { key: string; value: unknown; ts: string }

export function reportRowsFake<R extends FakeReading>(
  readings: readonly R[],
  url: string,
  extraTotal = 0,
): { history: R[]; historyTotal: number } {
  const q = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  const intervalMs = Number(q.get('intervalMs'));
  const keys = new Set((q.get('keys') ?? '').split(','));
  const from = Date.parse(q.get('from') ?? '');
  const to = Date.parse(q.get('to') ?? '');
  const inRange = (r: R) => Date.parse(r.ts) >= from && Date.parse(r.ts) <= to;
  const ofKeys = readings.filter((r) => keys.has(r.key) && inRange(r));
  const instants = [...new Set(ofKeys.map((r) => Date.parse(r.ts)))].sort((a, b) => a - b);
  const kept = new Set<number>();
  const slots = new Set<number>();
  for (const t of instants) {
    const slot = Math.floor((t - instants[0]) / intervalMs);
    if (!slots.has(slot)) { slots.add(slot); kept.add(t); }
  }
  return {
    history: ofKeys.filter((r) => kept.has(Date.parse(r.ts))).sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)),
    historyTotal: readings.filter(inRange).length + extraTotal,
  };
}
