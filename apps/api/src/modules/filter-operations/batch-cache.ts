/**
 * Request-scoped read memo for getBatchStates (M39).
 *
 * getBatchStates fans getCurrentState out across every active filter. Most of
 * what getCurrentState reads is NOT per-filter — the stage-interlock config, the
 * cleaning-profile-assignment config, the cleaning-reasons list, each cleaning
 * profile's pipeline (199 filters share ~51 profiles), each AHU's PM entry, and
 * the shared ancestors every filter's home-block walk climbs through. Pre-fix
 * each of those was re-read once PER FILTER: 3,099 Prisma reads for 199 filters.
 *
 * This memo collapses the shared reads to one apiece for the duration of a single
 * batch call. It is deliberately NOT a cross-request cache — it lives and dies
 * inside one getBatchStates call, so there is no invalidation problem and no
 * staleness window: a batch is already a point-in-time snapshot.
 *
 * If anything, memoizing makes the snapshot MORE coherent than before — pre-fix,
 * filter #1 and filter #199 could read different values of the same config row if
 * an admin saved between them. Now every filter in a batch sees one config.
 *
 * Correctness rule: the key MUST encode the projection, not just the id. Two call
 * sites reading the same AssetInstance with different `select` shapes must not
 * share an entry — hence keys like `hb:<id>` vs `attrs:<id>`.
 *
 * Promises (not values) are stored so the 10-wide `Promise.allSettled` chunk in
 * getBatchStatesImpl dedupes in-flight reads too, not just completed ones.
 */
export interface BatchReadCache {
  /** Run `load` once per key for the life of this cache; concurrent callers share the in-flight promise. */
  memo<T>(key: string, load: () => Promise<T>): Promise<T>;
}

export function createBatchReadCache(): BatchReadCache {
  const store = new Map<string, Promise<unknown>>();
  return {
    memo<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = store.get(key);
      if (hit) return hit as Promise<T>;
      const p = load();
      // A rejected read must not be cached as a permanent failure for the rest of
      // the batch — drop it so a later filter can retry (matches the pre-fix
      // behaviour, where every filter issued its own read).
      p.catch(() => { if (store.get(key) === p) store.delete(key); });
      store.set(key, p);
      return p;
    },
  };
}
