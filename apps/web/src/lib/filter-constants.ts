/** UI-enriched stage definitions for the filter operations page */
export const CLEANING_STAGES_OPS = [
  { key: 'WASH_IN', label: 'Wash In', icon: '🚿', color: 'from-sky-600 to-sky-700', border: 'border-sky-600', activeBg: 'bg-sky-50', needsBlock: true },
  { key: 'WASH_OUT', label: 'Wash Out', icon: '💧', color: 'from-sky-600 to-sky-800', border: 'border-sky-500', activeBg: 'bg-sky-50', needsBlock: false },
  { key: 'DRY_IN', label: 'Dry In', icon: '🌡️', color: 'from-amber-600 to-amber-700', border: 'border-amber-600', activeBg: 'bg-amber-50', needsBlock: true },
  { key: 'DRY_OUT', label: 'Dry Out', icon: '☀️', color: 'from-amber-600 to-amber-800', border: 'border-amber-500', activeBg: 'bg-amber-50', needsBlock: false },
  { key: 'STORAGE_IN', label: 'Storage In', icon: '📥', color: 'from-slate-500 to-slate-600', border: 'border-slate-400', activeBg: 'bg-slate-50', needsBlock: false },
  { key: 'STORAGE_OUT', label: 'Storage Out', icon: '📤', color: 'from-slate-500 to-slate-700', border: 'border-slate-300', activeBg: 'bg-slate-50', needsBlock: false },
];

/**
 * Stage definitions for the mobile shell — used by both `mobile-wrapper.tsx`
 * (home grid) and `mobile-operations.tsx` (stage-card view). These two files
 * previously each had their own identical literal; the deep review flagged
 * them as a drift risk (same kind of bug the block-change-dialog drift fix
 * closed earlier). Single source of truth now.
 *
 * Why a separate export from CLEANING_STAGES_OPS: the mobile and desktop
 * stage cards use different design systems (different tailwind class names,
 * different field shape). Mobile uses `gradient` / `bg` / `border` / `text`;
 * desktop uses `color` / `border` / `activeBg`. Keeping them as separate
 * exports avoids one page rendering with the wrong color palette.
 */
export const CLEANING_STAGES_MOBILE = [
  { key: 'WASH_IN', label: 'Wash In', icon: '\u{1F6BF}', gradient: 'from-sky-500 to-sky-600', bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-700', needsBlock: true },
  { key: 'WASH_OUT', label: 'Wash Out', icon: '\u{1F4A7}', gradient: 'from-sky-400 to-sky-500', bg: 'bg-sky-50', border: 'border-sky-200', text: 'text-sky-600', needsBlock: false },
  { key: 'DRY_IN', label: 'Dry In', icon: '\u{1F321}️', gradient: 'from-amber-500 to-orange-500', bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-700', needsBlock: true },
  { key: 'DRY_OUT', label: 'Dry Out', icon: '☀️', gradient: 'from-amber-400 to-amber-500', bg: 'bg-amber-50', border: 'border-amber-200', text: 'text-amber-600', needsBlock: false },
  { key: 'STORAGE_IN', label: 'Storage In', icon: '\u{1F4E5}', gradient: 'from-slate-500 to-slate-600', bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-600', needsBlock: false },
  { key: 'STORAGE_OUT', label: 'Storage Out', icon: '\u{1F4E4}', gradient: 'from-slate-400 to-slate-500', bg: 'bg-slate-50', border: 'border-slate-200', text: 'text-slate-500', needsBlock: false },
];

/**
 * A filter that has finished a cleaning cycle. A real `current_lifecycle_state`
 * (75 rows live on 2026-07-17) but NOT one of CLEANING_STAGES_MOBILE, so it has
 * no stage tile — it is reachable from the Status stage dropdown only.
 */
export const LIFECYCLE_CYCLE_COMPLETED = 'CLEANING_CYCLE_COMPLETED';

/**
 * Options for the tablet Status stage dropdown: All + Completed + the six
 * cleaning stages. Derived from CLEANING_STAGES_MOBILE so a stage added there
 * shows up here automatically. Retired filters never reach the Status tab
 * (excluded upstream by `status !== 'Retired'`), so there is no Retired option.
 */
export const STATUS_STAGE_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: LIFECYCLE_CYCLE_COMPLETED, label: 'Completed' },
  ...CLEANING_STAGES_MOBILE.map((s) => ({ value: s.key, label: s.label })),
];

/** Stage definitions for the cleaning-profile-editor canvas sidebar */
export const CLEANING_STAGES_EDITOR = [
  { key: 'WASH_IN',     name: 'Wash In',     color: '#3B8BD4' },
  { key: 'WASH_OUT',    name: 'Wash Out',    color: '#3B8BD4' },
  { key: 'DRY_IN',      name: 'Dry In',      color: '#EF9F27' },
  { key: 'DRY_OUT',     name: 'Dry Out',     color: '#EF9F27' },
  { key: 'STORAGE_IN',  name: 'Storage In',  color: '#888780' },
  { key: 'STORAGE_OUT', name: 'Storage Out', color: '#888780' },
];

export const FILTER_STATE_COLORS: Record<string, string> = {
  INSTALLED: 'bg-blue-500',
  WASH_IN: 'bg-sky-500',
  WASH_OUT: 'bg-sky-400',
  DRY_IN: 'bg-amber-500',
  DRY_OUT: 'bg-amber-400',
  STORAGE_IN: 'bg-slate-400',
  STORAGE_OUT: 'bg-slate-300',
  IN_USE: 'bg-emerald-500',
  CLEANING_CYCLE_COMPLETED: 'bg-green-500',
  RETIRED: 'bg-red-500',
};
