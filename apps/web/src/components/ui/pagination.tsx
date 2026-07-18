import { usePaginationDefaults } from '@/hooks/use-pagination-config';

/**
 * Canonical app-wide pagination control. ONE style everywhere:
 *   "Showing a–b of N"   [Rows: N ▾]   ‹ 1 2 3 … 13 ›
 *
 * Works for both client-side (totalItems = array length) and server-side
 * (totalItems = response.total) paging. The rows-per-page selector only renders
 * when `onPageSizeChange` is provided. Active page uses the active theme colour.
 *
 * Usage (client-side slice):
 *   const [page, setPage] = useState(1);
 *   const [pageSize, setPageSize] = useState(25);
 *   const pageRows = rows.slice((page-1)*pageSize, page*pageSize);
 *   <Pagination page={page} pageSize={pageSize} totalItems={rows.length}
 *     onPageChange={setPage} onPageSizeChange={setPageSize} />
 */
export interface PaginationProps {
  page: number;
  pageSize: number;
  totalItems: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
  className?: string;
}

function pageList(page: number, totalPages: number): (number | 'gap')[] {
  const out: (number | 'gap')[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= page - 1 && i <= page + 1)) {
      out.push(i);
    } else if (out[out.length - 1] !== 'gap') {
      out.push('gap');
    }
  }
  return out;
}

export function Pagination({ page, pageSize, totalItems, onPageChange, onPageSizeChange, pageSizeOptions, className }: PaginationProps) {
  const { options } = usePaginationDefaults();
  const baseOptions = pageSizeOptions ?? options;
  // Always include the current page size so the selector never renders blank
  // (a page may default to a size not in the configured option list, e.g. 20).
  const sizeOptions = baseOptions.includes(pageSize)
    ? baseOptions
    : [...baseOptions, pageSize].sort((a, b) => a - b);
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
  const safePage = Math.min(Math.max(1, page), totalPages);
  const from = totalItems === 0 ? 0 : (safePage - 1) * pageSize + 1;
  const to = Math.min(safePage * pageSize, totalItems);

  return (
    <div className={`flex items-center justify-between gap-3 flex-wrap px-4 py-3 ${className ?? ''}`}>
      <p className="text-xs text-slate-500">
        Showing <span className="font-semibold text-slate-700">{from}</span>–
        <span className="font-semibold text-slate-700">{to}</span> of{' '}
        <span className="font-semibold text-slate-700">{totalItems}</span>
      </p>

      <div className="flex items-center gap-3">
        {onPageSizeChange && (
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            Rows:
            <select
              value={pageSize}
              onChange={(e) => { onPageSizeChange(Number(e.target.value)); onPageChange(1); }}
              className="border border-slate-200 rounded-lg px-2 py-1 text-xs text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
            >
              {sizeOptions.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          </label>
        )}

        {totalPages > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(Math.max(1, safePage - 1))}
              disabled={safePage === 1}
              aria-label="Previous page"
              className="w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
            {pageList(safePage, totalPages).map((p, i) =>
              p === 'gap' ? (
                <span key={`gap-${i}`} className="w-8 h-8 flex items-center justify-center text-slate-400">…</span>
              ) : (
                <button
                  key={p}
                  onClick={() => onPageChange(p)}
                  className={`min-w-8 h-8 px-2 rounded-lg text-sm font-semibold transition-colors ${
                    p === safePage ? 'text-white shadow-sm' : 'text-slate-500 hover:bg-slate-100'
                  }`}
                  style={p === safePage ? { backgroundColor: 'var(--theme-primary)' } : undefined}
                >
                  {p}
                </button>
              )
            )}
            <button
              onClick={() => onPageChange(Math.min(totalPages, safePage + 1))}
              disabled={safePage === totalPages}
              aria-label="Next page"
              className="w-8 h-8 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent flex items-center justify-center transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
