import type { FilterRef } from '../types';

type Props = {
  filter: FilterRef;
  action: 'retire' | 'replace';
  remarks: string;
  submitting: boolean;
  onActionChange: (a: 'retire' | 'replace') => void;
  onRemarksChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function RetireReplacePanel({
  filter, action, remarks, submitting,
  onActionChange, onRemarksChange, onClose, onSubmit,
}: Props) {
  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-50 flex flex-col border-l border-slate-200 animate-in slide-in-from-right">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="text-lg font-semibold text-slate-800">Retire / Replace Filter</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Filter ID</label>
            <input
              type="text"
              value={filter.name}
              readOnly
              className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Action</label>
            <select
              value={action}
              onChange={e => onActionChange(e.target.value as 'retire' | 'replace')}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-[var(--theme-focus-ring)] focus:border-[var(--theme-primary)]"
            >
              <option value="retire">Retirement</option>
              <option value="replace">Replacement</option>
            </select>
          </div>
          <div className={`rounded-lg p-3 text-xs ${action === 'retire' ? 'bg-red-50 text-red-700 border border-red-200' : 'bg-blue-50 text-blue-700 border border-blue-200'}`}>
            {action === 'retire'
              ? 'This will permanently retire the filter. It will be removed from the active filter list and cannot perform cleaning operations.'
              : 'This will retire the current filter and create a new replacement filter with the same details and an incremented suffix number.'}
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Remarks <span className="text-red-500">*</span>
            </label>
            <textarea
              value={remarks}
              onChange={e => onRemarksChange(e.target.value)}
              placeholder="Enter reason for retirement/replacement..."
              rows={4}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 resize-none focus:ring-2 focus:ring-[var(--theme-focus-ring)] focus:border-[var(--theme-primary)]"
            />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSubmit}
            disabled={!remarks.trim() || submitting}
            className={`flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
              action === 'retire'
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-[var(--theme-primary)] hover:opacity-90'
            }`}
          >
            {submitting ? 'Processing...' : action === 'retire' ? 'Retire Filter' : 'Replace Filter'}
          </button>
        </div>
      </div>
    </>
  );
}
