import { useState, useEffect, useCallback } from 'react';
import { getAllOperations, deleteOperation, updateOperationStatus } from '@/lib/offline-store';
import { syncPendingOperations, onSyncEvent } from '@/lib/sync-engine';

/**
 * Floating "couldn't sync" review panel.
 *
 * Some queued offline operations are terminal-failed by design (the cycle ended
 * on the server, another operator changed it → stale tape, the cycle was never
 * started, etc.) and the sync engine does NOT keep retrying them. Without a
 * surface, that work silently sits in IndexedDB and the operator never knows.
 *
 * This panel shows a count of failed ops and lets the operator either RETRY one
 * (reset to pending → trigger a drain) or DISMISS it (delete from the queue once
 * they've decided to re-perform the step manually). Self-contained: mount it once
 * (mobile wrapper + desktop layout); it polls on mount, on every sync event, and
 * every 8s, and renders nothing when there are no failed ops.
 */

type FailedOp = {
  id: string;
  type: string;
  filterId: string;
  filterName: string;
  error?: string;
  createdAt: string;
};

const OP_LABEL: Record<string, string> = {
  'start-cycle': 'Start cycle',
  'start-and-advance': 'Start & submit',
  advance: 'Stage submit',
  'submit-checklist': 'Checklist',
  bypass: 'Bypass',
  terminate: 'Terminate cycle',
};

export function FailedOpsPanel() {
  const [failed, setFailed] = useState<FailedOp[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const all = await getAllOperations();
      setFailed(all.filter((o) => o.status === 'failed').map((o) => ({
        id: o.id, type: o.type, filterId: o.filterId, filterName: o.filterName,
        error: o.error, createdAt: o.createdAt,
      })));
    } catch { /* IDB read failure is non-fatal — try again next tick */ }
  }, []);

  useEffect(() => {
    refresh();
    const unsub = onSyncEvent(() => refresh());
    const t = setInterval(refresh, 8000);
    return () => { unsub(); clearInterval(t); };
  }, [refresh]);

  // Close the modal once everything's cleared.
  useEffect(() => { if (failed.length === 0) setOpen(false); }, [failed.length]);

  const retryOne = async (id: string) => {
    setBusy(true);
    try {
      await updateOperationStatus(id, 'pending');
      await syncPendingOperations();
    } finally { setBusy(false); await refresh(); }
  };

  const dismissOne = async (id: string) => {
    setBusy(true);
    try { await deleteOperation(id); } finally { setBusy(false); await refresh(); }
  };

  const retryAll = async () => {
    setBusy(true);
    try {
      for (const o of failed) await updateOperationStatus(o.id, 'pending');
      await syncPendingOperations();
    } finally { setBusy(false); await refresh(); }
  };

  const dismissAll = async () => {
    setBusy(true);
    try { for (const o of failed) await deleteOperation(o.id); }
    finally { setBusy(false); await refresh(); }
  };

  if (failed.length === 0) return null;

  return (
    <>
      {/* Floating banner — top-center, above page content, below modals */}
      <button
        onClick={() => setOpen(true)}
        className="fixed top-2 left-1/2 -translate-x-1/2 z-[60] inline-flex items-center gap-2 px-4 py-2 rounded-full bg-amber-500 text-white text-[13px] font-semibold shadow-lg shadow-amber-500/30 active:scale-95 transition-transform"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
        {failed.length} operation{failed.length !== 1 ? 's' : ''} couldn’t sync — tap to review
      </button>

      {open && (
        <div className="fixed inset-0 z-[70] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={() => setOpen(false)}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
            <div className="px-5 py-4 border-b border-slate-200 bg-amber-50 flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-slate-800">Operations that couldn’t sync</h3>
                <p className="text-[12px] text-slate-500">Retry to send again, or dismiss if you’ll re-do the step.</p>
              </div>
              <button onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>

            <div className="flex-1 overflow-auto divide-y divide-slate-100">
              {failed.map((o) => (
                <div key={o.id} className="px-5 py-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold text-slate-800 truncate">{o.filterName || 'Filter'}</div>
                    <div className="text-[11px] text-slate-500">{OP_LABEL[o.type] ?? o.type}</div>
                    {o.error && <div className="text-[11px] text-rose-600 mt-0.5 line-clamp-2">{o.error}</div>}
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button disabled={busy} onClick={() => retryOne(o.id)}
                      className="px-2.5 py-1 text-[12px] font-semibold rounded-lg bg-cyan-600 text-white disabled:opacity-50">Retry</button>
                    <button disabled={busy} onClick={() => dismissOne(o.id)}
                      className="px-2.5 py-1 text-[12px] font-semibold rounded-lg bg-slate-100 text-slate-600 disabled:opacity-50">Dismiss</button>
                  </div>
                </div>
              ))}
            </div>

            <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between gap-2">
              <button disabled={busy} onClick={dismissAll}
                className="px-3 py-2 text-[12px] font-semibold text-slate-500 hover:text-slate-700 disabled:opacity-50">Dismiss all</button>
              <button disabled={busy} onClick={retryAll}
                className="px-4 py-2 text-[13px] font-semibold rounded-lg bg-cyan-600 text-white disabled:opacity-50">
                {busy ? 'Working…' : 'Retry all'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
