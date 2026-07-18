import { Fragment } from 'react';
import { themeButton } from '@/lib/theme-styles';
import { UploadValidationResult } from '@/components/upload-validation-result';
import type { AhuOption, BulkUploadStep, DiagramFilterState, FilterFieldOptions } from '../types';

type Props = {
  step: BulkUploadStep;
  ahu: string;
  area: string;
  ahus: AhuOption[];
  areas: AhuOption[];
  file: File | null;
  rows: any[];
  error: string;
  results: any[];
  created: number;
  failed: number;
  fieldOptions: FilterFieldOptions;
  diagramFilter: DiagramFilterState;
  selectedBlockName: string;
  onAhuChange: (v: string) => void;
  onAreaChange: (v: string) => void;
  onFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: () => void;
  onClose: () => void;
  onChangeFile: () => void;
  onDownloadTemplate: () => void;
};

// Fixed column model — mirrors the Single Filter Creation fields (no
// templateId / attributeSchema). Dropdown columns list their LIVE master-data
// values so the operator knows what the Excel dropdowns will offer.
const fieldColumns = (opts: FilterFieldOptions) => [
  { key: 'name', label: 'name', hint: 'Filter Name — required, must be unique' },
  { key: 'filterSet', label: 'filterSet', hint: 'A or B (required — set per row in the Excel column)' },
  { key: 'ahuType', label: 'ahuType', hint: opts.ahuType.join(', ') || '—' },
  { key: 'filterType', label: 'filterType', hint: opts.filterType.join(', ') || '—' },
  { key: 'micronSize', label: 'micronSize', hint: (opts.micronSize.join(', ') || '—') + ' (µm)' },
  { key: 'filterSize', label: 'filterSize', hint: 'Free text — physical dimensions (e.g. 610×610×292mm)' },
  { key: 'lastCleaningDate', label: 'lastCleaningDate', hint: 'YYYY-MM-DD or NA' },
];

// Columns rendered in the preview table.
const PREVIEW_KEYS = ['name', 'filterSet', 'ahuType', 'filterType', 'micronSize', 'filterSize', 'lastCleaningDate'] as const;

export function BulkUploadDialog({
  step, ahu, area, ahus, areas, file, rows, error, results, created, failed, fieldOptions,
  diagramFilter, selectedBlockName,
  onAhuChange, onAreaChange,
  onFileSelect, onSubmit, onClose, onChangeFile, onDownloadTemplate,
}: Props) {
  const cols = fieldColumns(fieldOptions);
  // Validation errors carried from the dry-run (status === 'error').
  const validationErrors = (results ?? []).filter((r: any) => r.status === 'error');
  // Spreadsheet row numbers are 2-based (header = row 1); preview row i maps to row i+2.
  const errorRowNums = new Set(validationErrors.map((r: any) => r.row));
  const invalidPreviewRows = rows.filter((_: any, i: number) => errorRowNums.has(i + 2)).length;
  const validPreviewRows = rows.length - invalidPreviewRows;

  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[55] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl">
        {/* Header */}
        <div className="px-6 py-4 shrink-0 flex items-center justify-between" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
          <div>
            <h2 className="text-lg font-bold text-white">Bulk Upload Filters</h2>
            <p className="text-white/70 text-sm">
              {diagramFilter?.type === 'ahu' ? `Into ${diagramFilter.name}`
                : diagramFilter?.type === 'area' ? `Into ${diagramFilter.name} area`
                : `Into ${selectedBlockName}`}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-white/20 text-white/80 hover:text-white transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">

          {/* Picker block — Area / AHU / Default Set. Rendered on both `select`
              and `preview` so the operator can fix the AHU after parsing. */}
          {(step === 'select' || step === 'preview') && (
            <>
              {areas.length > 0 && (
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    Area <span className="text-slate-400 font-normal">(Optional)</span>
                  </label>
                  <select value={area} onChange={e => onAreaChange(e.target.value)}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-[var(--theme-focus-ring)] focus:border-[var(--theme-primary)]">
                    <option value="">All / Any</option>
                    {areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Target AHU <span className="text-red-500">*</span></label>
                {ahus.length === 0 ? (
                  <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700">
                    No AHUs found in this scope. Create an AHU first in the Structure view (or clear the Area filter above).
                  </div>
                ) : ahus.length === 1 ? (
                  <div className="px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-700">{ahus[0].name}</div>
                ) : (
                  <select value={ahu} onChange={e => onAhuChange(e.target.value)}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-[var(--theme-focus-ring)] focus:border-[var(--theme-primary)]">
                    <option value="">Select AHU...</option>
                    {ahus.map(h => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </select>
                )}
              </div>
            </>
          )}

          {/* Step: Select — template download + file upload */}
          {step === 'select' && (
            <>
              {/* Excel column reference — dropdown columns show their live values */}
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <h4 className="text-sm font-medium text-slate-600 mb-2">Excel Columns <span className="text-slate-400 font-normal">(the downloaded template has built-in dropdowns)</span></h4>
                <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
                  {cols.map(c => (
                    <Fragment key={c.key}>
                      <span className="font-mono text-theme-primary">{c.label}</span>
                      <span className="text-slate-400">{c.hint}</span>
                    </Fragment>
                  ))}
                </div>
              </div>

              <div className="flex items-center gap-3">
                <button onClick={onDownloadTemplate}
                  className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-100 text-slate-700 rounded-lg text-sm hover:bg-slate-200 transition-colors">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                  Download Excel Template
                </button>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Excel File (.xlsx) <span className="text-red-500">*</span></label>
                <div className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-[var(--theme-primary)] transition-colors cursor-pointer"
                  onClick={() => document.getElementById('bulk-upload-file-input')?.click()}>
                  <svg className="w-8 h-8 mx-auto text-slate-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                  <p className="text-sm text-slate-500">{file ? file.name : 'Click to select an .xlsx file'}</p>
                  <input id="bulk-upload-file-input" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={onFileSelect} />
                </div>
              </div>
              {error && <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">{error}</div>}
            </>
          )}

          {/* Step: Preview */}
          {step === 'preview' && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-600">Review before import — into <strong>{ahus.find(h => h.id === ahu)?.name ?? '—'}</strong></p>
                <button onClick={onChangeFile}
                  className="text-xs hover:opacity-80 font-medium text-theme-primary">Change file</button>
              </div>

              <UploadValidationResult
                importedCount={validPreviewRows}
                importedLabel="Valid (will import)"
                errors={validationErrors.map((er: any) => ({ row: er.row, reason: er.error, column: er.column, value: er.value }))}
              />

              <div className="max-h-64 overflow-auto border border-slate-200 rounded-lg">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-3 py-2 text-slate-500 font-medium">S.No</th>
                      {PREVIEW_KEYS.map(k => (
                        <th key={k} className="text-left px-3 py-2 text-slate-500 font-medium">{k}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r: any, i: number) => {
                      const bad = errorRowNums.has(i + 2);
                      return (
                        <tr key={i} className={`border-t border-slate-100 ${bad ? 'bg-red-50' : ''}`}>
                          <td className="px-3 py-1.5 text-slate-400">{i + 1}</td>
                          {PREVIEW_KEYS.map(k => (
                            <td key={k} className={`px-3 py-1.5 ${bad ? 'text-red-600' : 'text-slate-600'}`}>{r[k] || '--'}</td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* Step: Uploading */}
          {step === 'uploading' && (
            <div className="flex flex-col items-center py-10 gap-4">
              <div className="w-10 h-10 border-3 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
              <p className="text-sm text-slate-500">Creating {validPreviewRows} filter(s)...</p>
            </div>
          )}

          {/* Step: Results */}
          {step === 'results' && (
            <>
              <div className="flex gap-4">
                {created > 0 && (
                  <div className="flex-1 bg-green-50 border border-green-200 rounded-lg p-4 text-center">
                    <div className="text-2xl font-bold text-green-600">{created}</div>
                    <div className="text-xs text-green-500">Created</div>
                  </div>
                )}
                {failed > 0 && (
                  <div className="flex-1 bg-red-50 border border-red-200 rounded-lg p-4 text-center">
                    <div className="text-2xl font-bold text-red-600">{failed}</div>
                    <div className="text-xs text-red-500">Failed</div>
                  </div>
                )}
              </div>
              <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-lg">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Row</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Name</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Status</th>
                      <th className="text-left px-4 py-2 text-slate-500 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {results.map((r: any, i: number) => (
                      <tr key={i} className="border-t border-slate-100">
                        <td className="px-4 py-2 text-slate-400">{r.row}</td>
                        <td className="px-4 py-2 text-slate-700">{r.name}</td>
                        <td className="px-4 py-2">
                          {r.status === 'success'
                            ? <span className="text-green-600 font-medium">Created</span>
                            : <span className="text-red-600 font-medium">Failed</span>}
                        </td>
                        <td className="px-4 py-2 text-xs text-slate-400">
                          {r.error
                            ? <span className="text-red-500">{r.column ? `[${r.column}${r.value ? `="${r.value}"` : ''}] ` : ''}{r.error}</span>
                            : (r.id ? r.id.slice(0, 8) : '')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 flex gap-3 shrink-0">
          {step === 'results' ? (
            <button onClick={onClose} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-lg font-medium hover:bg-slate-200 transition-colors">Close</button>
          ) : (
            <>
              <button onClick={onClose} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-lg font-medium hover:bg-slate-200 transition-colors">Cancel</button>
              {step === 'preview' && (
                <button onClick={onSubmit} disabled={!ahu || validPreviewRows === 0}
                  className="flex-1 py-2.5 text-white rounded-lg font-semibold disabled:opacity-50 hover:opacity-90 transition-all flex items-center justify-center gap-2"
                  style={themeButton}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
                  Upload {validPreviewRows} Filter{validPreviewRows === 1 ? '' : 's'}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
