import type { SWRConfiguration } from 'swr';
import { swrConfig } from './swr-config';
import { isRefusal } from './refusal';

/** Retries pending, per SWR cache: one retry chain per key, however many failures arrive. */
const PENDING_RETRIES = new WeakMap<object, Set<string>>();

/** When SWR's merged config carries no cache (it always does at run time), one shared bucket of pending retries. */
const NO_CACHE = {};

/**
 * The ONE polling and retry policy of every polling hook on the dashboards (`/`
 * and `/dashboards/:id`) — the widget data hooks (fix round 1, I-1 / I-3) and,
 * since the final fix wave (R7-11), the overview behind the readings table, the
 * floor plan and every widget's instruments, the alarms panel, the two landing
 * summaries and the floor plans. Dashboards stay open all day on unattended
 * screens, and SWR 2.4 STOPS polling a key whose cache holds an error (its poll
 * `execute()` skips while `getCache().error` is set) while the app's
 * `errorRetryCount: 2` gives up after two retries — so a panel used to freeze,
 * or sit on its failure message, until someone focused the window. Here:
 *
 * - a FAILURE is retried at the hook's own refresh cadence, indefinitely (a
 *   cadence of 0 — a hook that does not poll — falls back to the configured
 *   `errorRetryInterval`, never a tight loop), with ONE retry chain per key in
 *   each SWR cache: a failure that arrives while a retry is pending (a focus, a
 *   mutate) starts no second chain;
 * - it is reported through the app's `onError` (`swr-config.ts`: the "Load
 *   Error" toast and its console line) on the FIRST failure of a key, not on
 *   every retry. A key is a request: a widget on a rolling period asks a new key
 *   every minute, so it reports again each minute of an outage, and N widgets
 *   report N times at its start. The per-hook `onError` is silent, so only this
 *   path reports; the app handler stays as it is for every other route;
 * - a REFUSAL (`isRefusal`) is never retried and never reported: the panel
 *   states it in its own body (the bar chart prints a 400's words), and a global
 *   toast for a state the card already explains is noise.
 *
 * SPREAD IT FIRST, then the hook's own options: it sets `keepPreviousData:
 * true`, and spread last it would turn a hook's `THIS_REQUEST_ONLY` back on.
 *
 * Options, not a hook: it reads nothing from React, so the many tests that mock
 * `swr`'s default export alone render the pages that poll through it. A leaf
 * module, so `use-telemetry.ts` can use it without an import cycle through the
 * widget data hooks.
 */
export function widgetPolling(refreshMs: number): SWRConfiguration {
  return {
    refreshInterval: refreshMs,
    keepPreviousData: true,
    shouldRetryOnError: (error: unknown) => !isRefusal(error),
    // Reported from onErrorRetry instead, so a key's failure is reported once.
    onError: () => {},
    onErrorRetry: (error, key, config, revalidate, opts) => {
      // The merged config SWR hands in carries its cache; one pending set per cache.
      const cache = (config as { cache?: object }).cache ?? NO_CACHE;
      const pending = PENDING_RETRIES.get(cache) ?? new Set<string>();
      PENDING_RETRIES.set(cache, pending);
      if (pending.has(key)) return;
      if (opts.retryCount === 1) swrConfig.onError?.(error, key, config as Parameters<NonNullable<typeof swrConfig.onError>>[2]);
      pending.add(key);
      setTimeout(() => {
        pending.delete(key);
        revalidate(opts);
      }, refreshMs > 0 ? refreshMs : config.errorRetryInterval);
    },
  };
}
