import type { LastCleaningDateState } from '../lib/lastCleaningDateState';

export type FilterFieldOptions = {
  ahuType: string[];
  filterType: string[];
  micronSize: string[];
  filterSize: string[];
};

type Props = {
  options: FilterFieldOptions;
  ahuType: string;
  filterType: string;
  micronSize: string;
  filterSize: string;
  lastCleaning: LastCleaningDateState;
  onAhuTypeChange: (v: string) => void;
  onFilterTypeChange: (v: string) => void;
  onMicronSizeChange: (v: string) => void;
  onFilterSizeChange: (v: string) => void;
  onLastCleaningChange: (next: LastCleaningDateState) => void;
};

export function FilterFieldOptionsSection({
  options, ahuType, filterType, micronSize, filterSize, lastCleaning,
  onAhuTypeChange, onFilterTypeChange, onMicronSizeChange, onFilterSizeChange, onLastCleaningChange,
}: Props) {
  const select = (value: string, list: string[], onChange: (v: string) => void, emptyHint: string) => (
    <select value={value} onChange={e => onChange(e.target.value)}
      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
      <option value="">{list.length === 0 ? emptyHint : 'Select…'}</option>
      {list.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  );

  return (
    <div className="space-y-3 pt-1 border-t border-slate-100">
      <div className="text-[11px] font-bold text-slate-500 uppercase tracking-wider pt-2">Filter Details</div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">AHU Type</label>
        {select(ahuType, options.ahuType, onAhuTypeChange, 'No options — configure in Settings')}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Filter Type</label>
        {select(filterType, options.filterType, onFilterTypeChange, 'No options — configure in Settings')}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Micron Size <span className="text-slate-400 font-normal">(µm)</span></label>
        {select(micronSize, options.micronSize, onMicronSizeChange, 'No options — configure in Settings')}
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Filter Dimensions</label>
        <input type="text" value={filterSize} onChange={e => onFilterSizeChange(e.target.value)}
          placeholder="e.g. 610×610×292mm"
          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
      </div>

      <div>
        <label className="block text-sm font-medium text-slate-700 mb-1">Last Cleaning Date</label>
        <div className="flex items-center gap-3">
          <input type="date"
            value={lastCleaning.date}
            disabled={lastCleaning.na}
            onChange={e => onLastCleaningChange({ ...lastCleaning, date: e.target.value })}
            className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500 disabled:bg-slate-50 disabled:text-slate-400" />
          <label className="flex items-center gap-1.5 text-sm text-slate-600 cursor-pointer select-none">
            <input type="checkbox"
              checked={lastCleaning.na}
              onChange={e => onLastCleaningChange({ na: e.target.checked, date: e.target.checked ? '' : lastCleaning.date })}
              className="w-4 h-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
            NA
          </label>
        </div>
      </div>
    </div>
  );
}
