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
  /**
   * Render the trigger as the download glyph ALONE — a square icon button, for
   * a card header that has no room for a labelled control.
   *
   * A real prop rather than a `className` that hides the text: the label is
   * emitted in BOTH branches below (the single-format button and the dropdown
   * trigger), so anything short of this leaves one of them still drawn. The
   * icon-only trigger carries `aria-label` and `title`, because a button whose
   * only content is an `aria-hidden` glyph has no accessible name at all.
   */
  iconOnly?: boolean;
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
export function ExportMenu({ surface, onExportPdf, onExportExcel, busy, className, iconOnly }: ExportMenuProps) {
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

  const iconBtnCls =
    'inline-flex items-center justify-center h-9 w-9 rounded-lg text-slate-500 bg-white border border-slate-200 hover:bg-slate-50 hover:text-slate-700 disabled:opacity-50 transition-colors';
  const btnCls = className ?? (iconOnly ? iconBtnCls :
    'inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-[0.8125rem] font-semibold text-slate-700 bg-white border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors');

  // Exactly one format allowed -> plain button.
  if (showPdf !== showExcel) {
    const isPdf = showPdf;
    const label = busy ? 'Exporting…' : isPdf ? 'Export as PDF' : 'Export as Excel';
    return (
      <button
        onClick={isPdf ? onExportPdf : onExportExcel}
        disabled={busy}
        className={btnCls}
        aria-label={iconOnly ? label : undefined}
        title={iconOnly ? label : undefined}
      >
        {DownloadIcon}
        {!iconOnly && label}
      </button>
    );
  }

  // Both allowed -> dropdown.
  const triggerLabel = busy ? 'Exporting…' : 'Export';
  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={busy}
        className={btnCls}
        aria-label={iconOnly ? triggerLabel : undefined}
        title={iconOnly ? triggerLabel : undefined}
        aria-haspopup={iconOnly ? 'menu' : undefined}
        aria-expanded={iconOnly ? open : undefined}
      >
        {DownloadIcon}
        {!iconOnly && triggerLabel}
        {/* The caret is what tells a labelled trigger it opens a menu. An
            icon-only one has no room for it and says so through `aria-haspopup`
            instead. */}
        {!iconOnly && (
          <svg className="w-3.5 h-3.5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        )}
      </button>
      {open && (
        <div className="absolute right-0 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-[var(--elev-2)] z-30 overflow-hidden">
          <button onClick={() => { setOpen(false); onExportPdf?.(); }}
            className="w-full flex items-center gap-2 text-left px-3.5 py-2.5 text-[0.8125rem] text-slate-700 hover:bg-slate-50">
            <span className="text-red-500 font-bold text-[0.6875rem]">PDF</span> Export as PDF
          </button>
          <button onClick={() => { setOpen(false); onExportExcel?.(); }}
            className="w-full flex items-center gap-2 text-left px-3.5 py-2.5 text-[0.8125rem] text-slate-700 hover:bg-slate-50 border-t border-slate-100">
            <span className="text-emerald-600 font-bold text-[0.6875rem]">XLS</span> Export as Excel
          </button>
        </div>
      )}
    </div>
  );
}
