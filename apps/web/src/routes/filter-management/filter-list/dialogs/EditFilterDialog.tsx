import type { FilterFieldOptions, LastCleaningDateState } from '../types';
import { FilterFieldOptionsSection } from '../components/FilterFieldOptionsSection';

type Props = {
  name: string;
  /** '' = this filter has no set assigned; neither button is highlighted. */
  filterSet: 'A' | 'B' | '';
  error: string;
  submitting: boolean;
  fieldOptions: FilterFieldOptions;
  ahuType: string;
  filterType: string;
  micronSize: string;
  filterSize: string;
  lastCleaning: LastCleaningDateState;
  onNameChange: (v: string) => void;
  onFilterSetChange: (v: 'A' | 'B') => void;
  onAhuTypeChange: (v: string) => void;
  onFilterTypeChange: (v: string) => void;
  onMicronSizeChange: (v: string) => void;
  onFilterSizeChange: (v: string) => void;
  onLastCleaningChange: (s: LastCleaningDateState) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function EditFilterDialog({
  name, filterSet, error, submitting,
  fieldOptions, ahuType, filterType, micronSize, filterSize, lastCleaning,
  onNameChange, onFilterSetChange,
  onAhuTypeChange, onFilterTypeChange, onMicronSizeChange, onFilterSizeChange, onLastCleaningChange,
  onClose, onSubmit,
}: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[55] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden flex flex-col shadow-2xl">
        <div className="px-6 py-4 shrink-0 flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500">
          <div>
            <h2 className="text-lg font-bold text-white">Edit Filter</h2>
            <p className="text-white/70 text-sm">Update filter name, set, and field details</p>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4 overflow-y-auto" style={{ maxHeight: 'calc(90vh - 160px)' }}>
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Filter Name <span className="text-red-500">*</span></label>
            <input type="text" value={name} onChange={e => onNameChange(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Filter Set</label>
            <div className="flex gap-2">
              {(['A', 'B'] as const).map(s => (
                <button key={s} type="button" onClick={() => onFilterSetChange(s)}
                  className={`flex-1 px-3 py-2 rounded-lg text-sm font-semibold border transition-colors ${
                    filterSet === s ? 'bg-amber-500 text-white border-amber-500' : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'
                  }`}>
                  Set {s}
                </button>
              ))}
            </div>
          </div>

          <FilterFieldOptionsSection
            options={fieldOptions}
            ahuType={ahuType}
            filterType={filterType}
            micronSize={micronSize}
            filterSize={filterSize}
            lastCleaning={lastCleaning}
            onAhuTypeChange={onAhuTypeChange}
            onFilterTypeChange={onFilterTypeChange}
            onMicronSizeChange={onMicronSizeChange}
            onFilterSizeChange={onFilterSizeChange}
            onLastCleaningChange={onLastCleaningChange}
          />
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
          <button onClick={onSubmit} disabled={submitting || !name.trim()}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
