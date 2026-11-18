import { buildTelemetryOverview } from './telemetry-overview.js';

/**
 * ONE overview computation per selection per 5 s, shared by every viewer who asks
 * the same question (performance audit 2026-11-17, P-02 / G2-01; operator chose
 * "share + compress").
 *
 * The overview is the API's capacity ceiling: ~0.9 s of single-threaded work at
 * 1,013 instruments, recomputed for EVERY viewer every 5 s (the dashboard poll) and
 * for every built-dashboard widget — 50 viewers took p50 to 5.9 s (E4). Its answer
 * depends only on the inputs in `overviewShareKey` (the caller's visibility and the
 * selection), the database and the clock, so two viewers with the same scope asking
 * within 5 s get the same rows: concurrent requests share the ONE computation in
 * flight, and its result is served for `OVERVIEW_SHARE_MS` after it lands. Readings
 * may therefore be up to 5 s older than now — the staleness the 5 s poll already has.
 *
 * NOT used by the alarm evaluator, which must judge the freshest reading — it calls
 * `buildTelemetryOverview` directly. A failed computation is never kept. The shared
 * rows are frozen (shallowly): a caller that mutated them would corrupt another
 * user's response, so it fails loudly instead.
 */
type OverviewOpts = NonNullable<Parameters<typeof buildTelemetryOverview>[0]>;
type OverviewRows = Awaited<ReturnType<typeof buildTelemetryOverview>>;

/** How long a computed overview is served; 0 = only share what is in flight. `OVERVIEW_SHARE_MS` overrides (the test bootstrap sets 0). */
export const OVERVIEW_SHARE_MS = (() => {
  const n = Number(process.env.OVERVIEW_SHARE_MS);
  return Number.isFinite(n) && n >= 0 ? n : 5_000;
})();
const MAX_ENTRIES = 256;

/** Every input the overview depends on; instrument ids sorted (the builder orders rows by code, not by id). */
export function overviewShareKey(opts: OverviewOpts): string {
  return JSON.stringify({
    visibility: opts.visibilityWhere ?? null,
    profileId: opts.profileId ?? null,
    instrumentIds: opts.instrumentIds ? [...opts.instrumentIds].sort() : null,
    floorplanId: opts.floorplanId ?? null,
    functionalLocationId: opts.functionalLocationId ?? null,
    functionalLocationDirect: Boolean(opts.functionalLocationDirect),
  });
}

export function createOverviewShare(
  build: (opts: OverviewOpts) => Promise<OverviewRows>,
  ttlMs: number = OVERVIEW_SHARE_MS,
  now: () => number = Date.now,
): (opts: OverviewOpts) => Promise<OverviewRows> {
  const entries = new Map<string, { promise: Promise<OverviewRows>; expiresAt: number }>();

  const prune = (t: number) => {
    for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key);
    while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value as string);
  };

  return (opts) => {
    const key = overviewShareKey(opts);
    const t = now();
    const hit = entries.get(key);
    if (hit && hit.expiresAt > t) return hit.promise;

    const entry = { promise: undefined as unknown as Promise<OverviewRows>, expiresAt: Number.POSITIVE_INFINITY };
    entry.promise = build(opts).then(
      (rows) => {
        for (const row of rows) Object.freeze(row);
        Object.freeze(rows);
        if (ttlMs > 0) entry.expiresAt = now() + ttlMs;
        else if (entries.get(key) === entry) entries.delete(key);
        return rows;
      },
      (err: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        throw err;
      },
    );
    entries.set(key, entry);
    prune(t);
    return entry.promise;
  };
}

/** The overview the routes serve: `buildTelemetryOverview`, shared per selection. */
export const sharedTelemetryOverview = createOverviewShare(buildTelemetryOverview);
