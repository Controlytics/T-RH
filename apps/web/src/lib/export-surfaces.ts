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
  { key: 'audit', label: 'Audit Trail' },
  { key: 'instrument-trend', label: 'Instrument Trend' },
  // The Instruments page's history widget (2026-09-05): the Data Report for
  // an Area, or for a hand-picked set of instruments.
  { key: 'instrument-history', label: 'Instrument History' },
  { key: 'alarms', label: 'Alarms' },
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
