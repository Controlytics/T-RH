import { useState, useRef, useEffect } from 'react';
import { useExportOptions } from '@/hooks/use-export-options';

interface ExportMenuProps {
  /** Surface key from export-surfaces.ts (e.g. 'filters', 'audit'). */
  surface: string;
  onExportPdf?: () => void;
  onExportExcel?: () => void;
  busy?: boolean;
  /** Override the trigger button classes (defaults to a slate outline button). */
  className?: string;
}

const DownloadIcon = (
  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" />
  </svg>
);

/**
 * Role-gated export control. Renders nothing when the current role is allowed
 * neither format for this surface; a single button when only one format is
 * allowed; a dropdown ("Export as PDF" / "Export as Excel") when both are.
 */
export function ExportMenu({ surface, onExportPdf, onExportExcel, busy, className }: ExportMenuProps) {
  const { pdf, excel } = useExportOptions(surface);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  const showPdf = pdf && !!onExportPdf;
  const showExcel = excel && !!onExportExcel;
  if (!showPdf && !showExcel) return null;

  const btnCls = className ??
    'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[13px] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors';

  // Exactly one format allowed -> plain button.
  if (showPdf !== showExcel) {
    const isPdf = showPdf;
    return (
      <button onClick={isPdf ? onExportPdf : onExportExcel} disabled={busy} className={btnCls}>
        {DownloadIcon}
        {busy ? 'Exporting…' : isPdf ? 'Export as PDF' : 'Export as Excel'}
      </button>
    );
  }

  // Both allowed -> dropdown.
  return (
    <div className="relative" ref={ref}>
      <button onClick={() => setOpen((o) => !o)} disabled={busy} className={btnCls}>
        {DownloadIcon}
        {busy ? 'Exporting…' : 'Export'}
        <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-lg z-30 overflow-hidden">
          <button onClick={() => { setOpen(false); onExportPdf?.(); }}
            className="w-full flex items-center gap-2 text-left px-3.5 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50">
            <span className="text-red-500 font-bold text-[11px]">PDF</span> Export as PDF
          </button>
          <button onClick={() => { setOpen(false); onExportExcel?.(); }}
            className="w-full flex items-center gap-2 text-left px-3.5 py-2.5 text-[13px] text-slate-700 hover:bg-slate-50 border-t border-slate-100">
            <span className="text-emerald-600 font-bold text-[11px]">XLS</span> Export as Excel
          </button>
        </div>
      )}
    </div>
  );
}
