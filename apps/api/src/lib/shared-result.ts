/**
 * ONE computation per key, shared by every caller asking the same question while it runs and for `ttlMs` after it
 * lands (performance audit 2026-11-17). Two users: the telemetry overview (R1, P-02 — `overview-share.ts`) and the
 * instant count of the merged history (G1-05 — `history-count-share.ts`). One implementation, so the single-flight,
 * expiry and failure rules cannot drift between them.
 *
 *  - Callers asking while the computation is in flight share it (the entry never expires before it settles).
 *  - A successful result is served for `ttlMs` after it LANDS; `0` = share only what is in flight.
 *  - A failure is never kept: the next caller computes again.
 *  - At most `maxEntries` keys are held; the oldest is evicted first (an evicted in-flight entry only loses sharing).
 *  - `onResult` runs once on a successful result before any caller sees it (the overview freezes its rows there).
 */
export function createSharedResult<A, R>(opts: {
  build: (arg: A) => Promise<R>;
  keyOf: (arg: A) => string;
  ttlMs: number;
  now?: () => number;
  onResult?: (result: R) => void;
  maxEntries?: number;
}): (arg: A) => Promise<R> {
  const now = opts.now ?? Date.now;
  const maxEntries = opts.maxEntries ?? 256;
  const entries = new Map<string, { promise: Promise<R>; expiresAt: number }>();

  const prune = (t: number) => {
    for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value as string);
  };

  return (arg) => {
    const key = opts.keyOf(arg);
    const t = now();
    const hit = entries.get(key);
    if (hit && hit.expiresAt > t) return hit.promise;

    const entry = { promise: undefined as unknown as Promise<R>, expiresAt: Number.POSITIVE_INFINITY };
    entry.promise = opts.build(arg).then(
      (result) => {
        opts.onResult?.(result);
        if (opts.ttlMs > 0) entry.expiresAt = now() + opts.ttlMs;
        else if (entries.get(key) === entry) entries.delete(key);
        return result;
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

/** A millisecond window from the environment: unset or unreadable = `fallback`; `0` is honoured. */
export function envMs(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
