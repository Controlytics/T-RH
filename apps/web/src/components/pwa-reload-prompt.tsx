/**
 * PWA reload prompt — audit 2026-05-04 fix (web-plumbing review H).
 *
 * vite-plugin-pwa's `autoUpdate` mode swaps the service worker on next
 * navigation, but JS that's already loaded in the operator's tab keeps
 * running against the OLD contract. With `skipWaiting + clientsClaim`
 * the new SW takes over on the next request, but the in-page bundle
 * is still stale until a refresh. Without a reload prompt, operators
 * on long shifts kept submitting old contracts to upgraded servers
 * (real failure mode that bit during prior deploys).
 *
 * This component subscribes to the `onNeedRefresh` callback from
 * `virtual:pwa-register/react`, shows a dismissable banner, and
 * triggers `updateServiceWorker(true)` (which causes a page reload)
 * on click.
 *
 * Mount once near the app root. Renders nothing until an update is
 * pending. Survives the operator dismissing it (re-shows on the next
 * SW update detected).
 */
import { useState, useEffect } from 'react';
// vite-plugin-pwa auto-generates this virtual module at build time.
// In dev mode it's a no-op shim; in production it wires up the SW
// lifecycle callbacks. The .d.ts ships with the plugin.
// eslint-disable-next-line import/no-unresolved
import { useRegisterSW } from 'virtual:pwa-register/react';

export function PwaReloadPrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(swUrl, r) {
      if (!r) return;
      // Re-check for updates every 60s. The SW only DOWNLOADS new bundles
      // when this triggers; without it the only update path is page reload,
      // which defeats the point of background-update PWA.
      //
      // Audit 2026-05-05 fix #11: pause polling on hidden tabs. Pre-fix,
      // 50 operators × 2 tabs each = ~100 SW probes per minute against
      // /sw.js even when nothing was happening — visible in the API access
      // log and burns the cache window. visibilitychange listener pauses
      // the interval when the tab goes to background and runs a single
      // catch-up update + restarts the interval when it comes back.
      let interval: ReturnType<typeof setInterval> | null = null;
      const start = () => {
        if (interval) return;
        interval = setInterval(() => { void r.update(); }, 60_000);
      };
      const stop = () => {
        if (!interval) return;
        clearInterval(interval);
        interval = null;
      };
      const onVisChange = () => {
        if (document.visibilityState === 'visible') {
          void r.update(); // catch-up immediately on resume
          start();
        } else {
          stop();
        }
      };
      document.addEventListener('visibilitychange', onVisChange);
      // Initial state — most tabs mount visible, but be defensive.
      if (document.visibilityState === 'visible') start();
    },
    onRegisterError(err) {
      console.warn('[pwa] SW register error:', err);
    },
  });

  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const visible = needRefresh && (dismissedAt == null || Date.now() - dismissedAt > 5 * 60_000);

  // Re-show 5 minutes after dismissal so a stale operator can't keep
  // dismissing forever — they get nudged back into refreshing.
  useEffect(() => {
    if (!needRefresh || dismissedAt == null) return;
    const t = setTimeout(() => setDismissedAt(null), 5 * 60_000);
    return () => clearTimeout(t);
  }, [needRefresh, dismissedAt]);

  if (!visible) return null;

  return (
    <div
      role="alertdialog"
      aria-labelledby="pwa-update-title"
      className="fixed bottom-4 right-4 z-50 w-80 max-w-[92vw] bg-white border border-slate-200 rounded-xl shadow-2xl p-4 animate-fade-in"
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-cyan-50 flex items-center justify-center text-cyan-600 shrink-0">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <div id="pwa-update-title" className="text-sm font-semibold text-slate-800">
            New version available
          </div>
          <p className="text-xs text-slate-500 mt-0.5">
            Refresh to load the latest UI and pick up server-contract changes.
          </p>
          <div className="flex items-center gap-2 mt-3">
            <button
              type="button"
              onClick={() => { void updateServiceWorker(true); }}
              className="px-3 py-1.5 bg-cyan-600 text-white text-xs font-semibold rounded-lg hover:bg-cyan-700 transition-colors"
            >
              Refresh now
            </button>
            <button
              type="button"
              onClick={() => { setDismissedAt(Date.now()); setNeedRefresh(false); }}
              className="px-3 py-1.5 text-slate-500 text-xs font-medium hover:text-slate-700"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
