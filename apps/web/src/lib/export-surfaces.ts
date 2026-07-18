// Export "surfaces" = the pages/reports that offer a PDF / Excel download.
// Used by the role-wise Export Options config (per-page x per-role) and by the
// <ExportMenu> gating hook. Keep this list in sync with the pages that render
// an <ExportMenu>.
export type ExportFormat = 'NONE' | 'PDF' | 'EXCEL' | 'BOTH';

export interface ExportSurface {
  key: string;
  label: string;
}

export const EXPORT_SURFACES: ExportSurface[] = [
  { key: 'filters', label: 'Filters' },
  { key: 'audit', label: 'Audit Trail' },
  { key: 'cleaning-record', label: 'Filter Cleaning Record' },
  { key: 'cleaning-detail', label: 'Cleaning Cycle Detail' },
  { key: 'lifecycle', label: 'Cleaning Lifecycle Report' },
  { key: 'deviations', label: 'Deviations' },
  { key: 'replacement', label: 'Replacement Schedule' },
  { key: 'rfid-track-record', label: 'RFID Track Record' },
  { key: 'pm', label: 'PM Schedules' },
  { key: 'qnn', label: 'Quality Notifications (QNN)' },
];

/** Resolve a stored format string into PDF/Excel button visibility.
 *  Fail-open: anything unrecognised (incl. undefined) -> both shown. */
export function formatToFlags(fmt: string | undefined | null): { pdf: boolean; excel: boolean } {
  switch (fmt) {
    case 'NONE': return { pdf: false, excel: false };
    case 'PDF': return { pdf: true, excel: false };
    case 'EXCEL': return { pdf: false, excel: true };
    case 'BOTH':
    default: return { pdf: true, excel: true };
  }
}
