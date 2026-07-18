export const STATUS_LABELS: Record<string, { label: string; color: string }> = {
  INSTALLED: { label: 'Installed', color: 'bg-blue-50 text-blue-700 border-blue-200' },
  WASH_IN: { label: 'Wash In', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  WASH_OUT: { label: 'Wash Out', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  DRY_IN: { label: 'Dry In', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  DRY_OUT: { label: 'Dry Out', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  STORAGE_IN: { label: 'Storage In', color: 'bg-slate-50 text-slate-600 border-slate-200' },
  STORAGE_OUT: { label: 'Storage Out', color: 'bg-slate-50 text-slate-600 border-slate-200' },
  IN_USE: { label: 'In Use', color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  CLEANING_CYCLE_COMPLETED: { label: 'Cleaning Cycle Completed', color: 'bg-green-50 text-green-700 border-green-200' },
  RETIRED: { label: 'Retired', color: 'bg-red-50 text-red-700 border-red-200' },
};

// Manual "Update Status" dropdown options. INSTALLED + IN_USE are intentionally
// NOT offered here (they remain valid system states for rendering, but operators
// don't set them manually). CLEANING_CYCLE_COMPLETED is the terminal state a
// cleaning cycle leaves the filter in (also auto-set on cycle completion).
export const LIFECYCLE_STATE_OPTIONS = [
  { value: 'WASH_IN', label: 'Wash In', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'WASH_OUT', label: 'Wash Out', color: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'DRY_IN', label: 'Dry In', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { value: 'DRY_OUT', label: 'Dry Out', color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { value: 'STORAGE_IN', label: 'Storage In', color: 'bg-slate-50 text-slate-600 border-slate-200' },
  { value: 'STORAGE_OUT', label: 'Storage Out', color: 'bg-slate-50 text-slate-600 border-slate-200' },
  { value: 'CLEANING_CYCLE_COMPLETED', label: 'Cleaning Cycle Completed', color: 'bg-green-50 text-green-700 border-green-200' },
];
