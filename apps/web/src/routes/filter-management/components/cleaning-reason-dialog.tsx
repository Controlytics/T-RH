import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { getCachedData } from '@/lib/offline-store';

interface CleaningReasonDialogProps {
  dialog: {
    filterId: string;
    filterName: string;
    stage: { key: string; label: string };
    block?: { id: string; name: string };
  } | null;
  onClose: () => void;
  onSubmit: (reasonKey: string, justification?: string) => void;
  loading: boolean;
  error: string;
  onClearError: () => void;
  // When the filter is PM-due: pre-select this reason (PM) and show a banner so
  // the operator confirms PM or picks another reason.
  defaultReasonKey?: string;
  pmDue?: boolean;
}

export function CleaningReasonDialog({ dialog, onClose, onSubmit, loading, error, onClearError, defaultReasonKey, pmDue }: CleaningReasonDialogProps) {
  const [selectedReason, setSelectedReason] = useState('');
  const [justification, setJustification] = useState('');

  const { data: reasonsData } = useSWR('/api/filters/reasons');
  const [offlineReasons, setOfflineReasons] = useState<any[]>([]);
  const onlineReasons = (reasonsData as any)?.reasons ?? reasonsData ?? [];
  const cleaningReasons = onlineReasons.length > 0 ? onlineReasons : offlineReasons;

  // Load cached reasons for offline use
  useEffect(() => {
    getCachedData<any[]>('cleaning-reasons').then(r => { if (r) setOfflineReasons(r); }).catch(() => {});
  }, []);

  // Reset internal state when dialog opens/closes
  useEffect(() => {
    if (dialog) {
      setSelectedReason(defaultReasonKey ?? '');
      setJustification('');
    }
  }, [dialog, defaultReasonKey]);

  if (!dialog) return null;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[55] p-4" onClick={onClose}>
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-cyan-600 to-blue-600 px-6 py-4">
          <h2 className="text-lg font-bold text-white">Select Cleaning Reason</h2>
          <p className="text-cyan-100 text-sm">{dialog.filterName} &rarr; {dialog.stage.label}</p>
        </div>
        <div className="p-6 space-y-4">
          {pmDue && (
            <div className="px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">
              This filter is in the <span className="font-semibold">PM schedule</span>. Reason defaults to <span className="font-semibold">PM</span> — confirm to continue, or pick another reason.
              <span className="block text-xs text-emerald-600 mt-0.5">A non-PM reason will leave this task pending in My Tasks.</span>
            </div>
          )}
          <div className="space-y-2">
            {cleaningReasons.filter((r: any) => r.isActive !== false).map((r: any) => (
              <button key={r.key} onClick={() => { setSelectedReason(r.key); onClearError(); }}
                className={`w-full text-left px-4 py-3 rounded-xl transition-all ${selectedReason === r.key ? 'bg-cyan-50 border-2 border-cyan-500' : 'bg-slate-100 border-2 border-transparent hover:border-slate-300'}`}>
                <div className="text-sm font-medium text-slate-800">{r.name}</div>
                {r.description && <div className="text-xs text-slate-400 mt-0.5">{r.description}</div>}
                {r.requiresJustification && <div className="text-[10px] text-amber-500 mt-0.5">Requires justification</div>}
              </button>
            ))}
          </div>
          {cleaningReasons.find((r: any) => r.key === selectedReason)?.requiresJustification && (
            <textarea className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-2 text-slate-800 text-sm placeholder:text-slate-400" rows={2}
              placeholder="Justification (min 10 characters)" value={justification} onChange={e => setJustification(e.target.value)} />
          )}
          {error && <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>}
          {(() => {
            // Match server contract at start-cycle.ts:78 — block submit when
            // the selected reason has requiresJustification=true unless the
            // operator has typed at least 10 chars. Pre-fix the button was
            // enabled, the server returned 400 JUSTIFICATION_REQUIRED, and
            // use-core.ts misclassified that as "queued" (bug fix 2026-05-25).
            const reason = cleaningReasons.find((r: any) => r.key === selectedReason);
            const needsJustification = !!reason?.requiresJustification;
            const justificationOk = !needsJustification || justification.trim().length >= 10;
            const submitDisabled = loading || !selectedReason || !justificationOk;
            return (
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl">Cancel</button>
                <button onClick={() => onSubmit(selectedReason, justification)} disabled={submitDisabled}
                  className="flex-1 py-3 bg-cyan-600 text-white rounded-xl font-bold disabled:opacity-40 hover:bg-cyan-500 transition-colors flex items-center justify-center gap-2">
                  {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : 'Start & Submit'}
                </button>
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
