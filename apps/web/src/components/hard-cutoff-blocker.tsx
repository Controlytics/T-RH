import { useEffect, useState } from 'react';
import { getHardCutoffMs, isHardCutoffExceeded, subscribeToHardCutoff } from '@/lib/hard-cutoff';
import { getLastServerContact } from '@/lib/server-contact';
import { HARD_CUTOFF_REEVAL_INTERVAL_MS } from '@/lib/timing-constants';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { getApiBase } from '@/lib/api-base';

/**
 * W4: read-only blocker overlay.
 *
 * Mounts at the app root (AppLayout + MobileWrapperPage). Renders nothing
 * under normal conditions. When the hard-cutoff window has elapsed since the
 * last successful server contact, renders a full-screen modal that explains
 * the lockout and offers a retry button.
 *
 * The overlay is purely visual. The actual mutation-refusal happens at the
 * apiClient layer (HARD_CUTOFF thrown before the network call) so even a
 * page that didn't mount this component or a user who used DevTools to hide
 * the overlay can't bypass the lockout.
 *
 * Re-evaluation cadence:
 *   - subscribeToHardCutoff fires on every markServerContact() call, so a
 *     successful API response or the 15s connectivity probe dismisses the
 *     blocker immediately
 *   - a 30s fallback interval re-evaluates in case the timestamp ages out
 *     while we're idle (no contact = no event → without the interval, the
 *     blocker would render late by up to a render cycle)
 */
export function HardCutoffBlocker() {
  const [exceeded, setExceeded] = useState<boolean>(() => isHardCutoffExceeded());
  const [retrying, setRetrying] = useState(false);
  const { formatDateTime } = useDatetimeFormat();

  useEffect(() => {
    const unsub = subscribeToHardCutoff(setExceeded);
    // Fallback poll for the "no contact at all" case where neither the
    // probe nor an apiClient call ever fires. Cheap — just a comparison.
    const t = setInterval(() => setExceeded(isHardCutoffExceeded()), HARD_CUTOFF_REEVAL_INTERVAL_MS);
    return () => {
      unsub();
      clearInterval(t);
    };
  }, []);

  if (!exceeded) return null;

  const lastContactMs = getLastServerContact();
  const lastContact = lastContactMs > 0 ? new Date(lastContactMs) : null;
  const cutoffHours = (getHardCutoffMs() / 3600_000).toFixed(cutoffPrecision());

  function cutoffPrecision(): number {
    const v = getHardCutoffMs() / 3600_000;
    if (v >= 1) return 0;
    return 2; // sub-hour values (e.g. 0.01h = 36s) need precision
  }

  const handleRetry = async () => {
    setRetrying(true);
    try {
      // Best-effort probe via the same engine the connectivity layer uses.
      // A successful response marks contact (in connectivity.ts), which
      // fires the subscribe listener, which flips exceeded to false.
      const baseUrl = getApiBase();
      await fetch(`${baseUrl}/api/health`, { method: 'GET' });
      // The probe itself didn't mark contact (that's done by the engine's
      // own probeServer) — but a deliberate apiClient GET would. Trigger
      // one to confirm reachability and mark contact in one shot.
      await import('@/lib/api-client').then(m => m.apiClient.get('/api/health')).catch(() => {});
    } finally {
      setRetrying(false);
      // Re-check after the probe — if it succeeded, the listener already
      // flipped state; if it failed, we stay locked.
      setExceeded(isHardCutoffExceeded());
    }
  };

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-slate-900/80 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="hard-cutoff-title"
    >
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
        <div className="h-1.5 bg-gradient-to-r from-red-500 to-rose-600" />
        <div className="p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-2xl bg-red-50 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div>
              <h2 id="hard-cutoff-title" className="text-lg font-bold text-slate-800">Read-only Mode</h2>
              <p className="text-xs text-slate-500">No server contact for over {cutoffHours}h</p>
            </div>
          </div>

          <div className="space-y-3 mb-5 text-sm text-slate-700">
            <p>
              The app has not been able to reach the server in over <strong>{cutoffHours} hours</strong>.
              For data integrity (21 CFR Part 11), mutations are temporarily disabled.
            </p>
            <p className="text-slate-500">
              You can still view cached data. Once connectivity resumes, this banner will
              dismiss automatically and operations will resume.
            </p>

            {lastContact && (
              <div className="bg-slate-50 rounded-xl p-3 text-xs">
                <div className="text-slate-500">Last successful server contact:</div>
                <div className="font-semibold text-slate-800 mt-0.5">{formatDateTime(lastContact)}</div>
              </div>
            )}
          </div>

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleRetry}
              disabled={retrying}
              className="flex-1 py-2.5 bg-gradient-to-r from-cyan-600 to-teal-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-lg shadow-cyan-500/25"
            >
              {retrying ? 'Trying…' : 'Try to reconnect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
