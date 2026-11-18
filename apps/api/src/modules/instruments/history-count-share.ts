import { createSharedResult, envMs } from '../../lib/shared-result.js';
import { countHistoryInstants, type HistorySelection } from './telemetry.repository.js';

/**
 * The merged history's instant count, computed ONCE per selection (performance audit G1-05; operator 2026-11-18:
 * "Index + count once"). The Data Report table and the time-series widget page by offset and need the total for the
 * pager — it was recounted on EVERY page click (5.4 s at 30 instruments x 30 days on the perf copy; 2.3 s now that it
 * is index-served). Every page of one selection asks the same question, so the answer is shared for
 * `HISTORY_COUNT_SHARE_MS` (60 s) after it lands, and callers asking while it runs share the one computation.
 *
 * The key is everything the count depends on: the instrument ids AFTER visibility (the route passes only the visible
 * ones, so two scopes can never share a count they are not both allowed), sorted; the keys, sorted; the period.
 *
 * Staleness: a period preset is resolved to a FIXED range when chosen (`useTrendPeriod.setPreset`), so new readings
 * fall after its end and do not change the count. Only a reading that arrives LATE with a device timestamp inside the
 * window, or a period ending in the future, can make the total lag — by at most the window. A rolling widget range
 * changes its `to` on every poll, which is a new key: it never reuses an old count. The rows themselves are always read
 * fresh. Vitest sets `HISTORY_COUNT_SHARE_MS=0` (`vitest.env.ts`): tests insert readings and count straight after.
 */
export const HISTORY_COUNT_SHARE_MS = envMs('HISTORY_COUNT_SHARE_MS', 60_000);

export function historyCountKey(q: HistorySelection): string {
  return JSON.stringify({
    instrumentIds: [...q.instrumentIds].sort(),
    keys: q.keys && q.keys.length > 0 ? [...q.keys].sort() : null,
    from: q.from ? q.from.toISOString() : null,
    to: q.to ? q.to.toISOString() : null,
  });
}

export function createHistoryCountShare(
  count: (q: HistorySelection) => Promise<number> = countHistoryInstants,
  ttlMs: number = HISTORY_COUNT_SHARE_MS,
  now: () => number = Date.now,
): (q: HistorySelection) => Promise<number> {
  return createSharedResult({ build: count, keyOf: historyCountKey, ttlMs, now });
}

/** The count the history routes serve. */
export const sharedHistoryCount = createHistoryCountShare();
