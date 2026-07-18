/**
 * Shared Excel/CSV upload validation result — used by every data-import dialog
 * (PM Schedules, Filter Bulk Upload [Filters page + AHU Dashboard], Replacement
 * Schedule) so they all show the same "processed N rows · imported · errors with
 * Row X — reason" summary. Each call site normalizes its own backend response
 * into `importedCount` + `errors[]`.
 */
export interface UploadRowError {
  row: number;
  reason: string;
  column?: string;
  value?: string;
}

export interface UploadValidationResultProps {
  importedCount: number;
  errors: UploadRowError[];
  /** Label under the success count. Default "Imported". */
  importedLabel?: string;
}

export function UploadValidationResult({ importedCount, errors, importedLabel = 'Imported' }: UploadValidationResultProps) {
  const total = importedCount + errors.length;
  const hasErrors = errors.length > 0;
  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold text-slate-700">
        Validation result — processed {total} row{total === 1 ? '' : 's'}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
          <div className="text-2xl font-bold text-emerald-700">{importedCount}</div>
          <div className="text-xs text-emerald-600 font-semibold mt-0.5">{importedLabel}</div>
        </div>
        <div className={`rounded-xl p-4 border ${hasErrors ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`}>
          <div className={`text-2xl font-bold ${hasErrors ? 'text-rose-700' : 'text-slate-400'}`}>{errors.length}</div>
          <div className={`text-xs font-semibold mt-0.5 ${hasErrors ? 'text-rose-600' : 'text-slate-400'}`}>Errors (not imported)</div>
        </div>
      </div>
      {hasErrors ? (
        <div>
          <div className="text-xs font-semibold text-rose-600 uppercase tracking-wider mb-2">Rows with errors — fix and re-upload</div>
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {errors.map((e, i) => (
              <div key={`${e.row}-${i}`} className="flex items-start gap-2 text-sm px-3 py-2 bg-rose-50 border border-rose-100 rounded-lg">
                <span className="shrink-0 inline-flex items-center justify-center w-5 h-5 rounded-full bg-rose-100 text-rose-600 text-[11px] font-bold">!</span>
                <span className="text-slate-700">
                  <b>Row {e.row}</b>
                  {e.column ? <> · column <b>{e.column}</b></> : null}
                  {e.value ? <> · value “{e.value}”</> : null}
                  {' — '}{e.reason}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-lg px-3 py-2">
          ✓ All rows passed validation — no errors.
        </div>
      )}
    </div>
  );
}
