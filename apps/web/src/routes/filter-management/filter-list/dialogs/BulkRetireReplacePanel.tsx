type Props = {
  action: 'retire' | 'replace';
  selectedCount: number;
  selectedFilters: { id: string; name: string }[];
  remarks: string;
  submitting: boolean;
  onRemarksChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function BulkRetireReplacePanel({
  action, selectedCount, selectedFilters, remarks, submitting,
  onRemarksChange, onClose, onSubmit,
}: Props) {
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-50 flex flex-col border-l border-slate-200 animate-in slide-in-from-right">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="text-lg font-semibold text-slate-800">Bulk {action === 'retire' ? 'Retirement' : 'Replacement'}</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div className={`rounded-lg p-3 text-xs border ${action === 'retire' ? 'bg-red-50 text-red-700 border-red-200' : 'bg-orange-50 text-orange-700 border-orange-200'}`}>
            {action === 'retire'
              ? <>This will permanently retire <strong>{selectedCount} filter(s)</strong>. They will be removed from the active filter list.</>
              : <>This will retire <strong>{selectedCount} filter(s)</strong> and create replacement filters with incremented suffix numbers.</>
            }
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Selected Filters</label>
            <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg p-2 space-y-1">
              {selectedFilters.map(f => (
                <div key={f.id} className="text-xs text-slate-600 px-2 py-1 bg-slate-50 rounded">{f.name}</div>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Remarks <span className="text-red-500">*</span></label>
            <textarea value={remarks} onChange={e => onRemarksChange(e.target.value)}
              placeholder={`Enter reason for ${action === 'retire' ? 'retirement' : 'replacement'}...`} rows={4}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 resize-none focus:ring-2 focus:ring-[var(--theme-focus-ring)] focus:border-[var(--theme-primary)]" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
          <button onClick={onSubmit} disabled={!remarks.trim() || submitting}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              action === 'retire' ? 'bg-red-600 hover:bg-red-700' : 'bg-orange-600 hover:bg-orange-700'
            }`}>
            {submitting ? 'Processing...' : `${action === 'retire' ? 'Retire' : 'Replace'} ${selectedCount} Filter(s)`}
          </button>
        </div>
      </div>
    </>
  );
}
