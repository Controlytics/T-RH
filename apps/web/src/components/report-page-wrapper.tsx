import { useReportPageTitles } from '@/hooks/use-report-page-titles';
import { useAuth } from '@/hooks/use-auth';

interface ReportPageWrapperProps {
  title: string;
  totalRecords: number;
  page: number;
  totalPages: number;
  children: React.ReactNode;
  /**
   * Hide the record-count + "Page X of Y" row in the report footer. Use on
   * pages that render their own pagination control so the numbers aren't shown
   * twice. The identity line (logo + company · application name) still renders.
   * Opt-in — defaults to false so other reports keep the full footer.
   */
  hideFooterStats?: boolean;
  /**
   * Hide the report footer entirely (identity line + stats). Opt-in — use on
   * pages where the footer below the page's own pagination is unwanted.
   */
  hideFooter?: boolean;
}

/**
 * Shared on-screen chrome for report pages: a header (logo + company + app name +
 * report title + performed-by) and a footer with the same identity line, plus a
 * record-count + page row (suppressible via `hideFooterStats` for pages that
 * carry their own pagination). Report identity is configurable at
 * Config → Report Page Titles (override → Branding); the logo comes from Branding.
 */
export function ReportPageWrapper({ title, totalRecords, page, totalPages, children, hideFooterStats, hideFooter }: ReportPageWrapperProps) {
  const { branding, companyName, appName } = useReportPageTitles();
  const { user } = useAuth();

  // Logo block reused in the header and footer (report-specific company/app name
  // come from Report Page Titles, falling back to Branding; logo from Branding).
  const Logo = ({ size }: { size: 'lg' | 'sm' }) => {
    const dim = size === 'lg' ? 'h-10 w-10' : 'h-6 w-6';
    return branding.logoUrl ? (
      <img src={branding.logoUrl} alt="Logo" className={`${size === 'lg' ? 'h-10' : 'h-6'} w-auto object-contain`} />
    ) : (
      <div className={`${dim} rounded-lg flex items-center justify-center text-white font-bold ${size === 'lg' ? 'text-sm' : 'text-[9px]'}`}
        style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
        {branding.logoText || 'DL'}
      </div>
    );
  };

  return (
    <div className="space-y-0">
      {/* ── Report Header ── */}
      <div className="bg-white border border-slate-200 rounded-t-xl px-6 py-4 print:border-0">
        <div className="flex items-center justify-between gap-4">
          {/* Left: logo */}
          <div className="flex items-center gap-3 shrink-0"><Logo size="lg" /></div>
          {/* Center: company + application name + report title */}
          <div className="flex-1 text-center">
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">{companyName}</p>
            {appName && <p className="text-[11px] font-medium text-slate-500">{appName}</p>}
            <h2 className="text-lg font-bold text-slate-800">{title}</h2>
          </div>
          {/* Right: performed-by */}
          <div className="text-right text-xs text-slate-400 space-y-0.5 shrink-0 min-w-[110px]">
            {user && <p>By: {user.fullName || user.username}</p>}
          </div>
        </div>
        {/* Theme accent bar */}
        <div className="h-0.5 mt-3 rounded-full" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
      </div>

      {/* ── Report Content ── */}
      <div>{children}</div>

      {/* ── Report Footer ── identity line + (optionally) record-count + page.
          `hideFooterStats` drops the count/page row (identity stays);
          `hideFooter` drops the whole footer. */}
      {!hideFooter && (
      <div className={`bg-white border border-slate-200 border-t-0 rounded-b-xl px-6 py-3 print:border-0 ${hideFooterStats ? '' : 'space-y-2'}`}>
        <div className={`flex items-center justify-center gap-2 text-[11px] text-slate-400 ${hideFooterStats ? '' : 'pb-2 border-b border-slate-100'}`}>
          <Logo size="sm" />
          <span className="font-medium text-slate-500">{companyName}</span>
          {appName && <><span className="text-slate-300">·</span><span>{appName}</span></>}
        </div>
        {!hideFooterStats && (
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-400">{totalRecords} records</div>
            <div className="text-xs text-slate-400">Page {page} of {totalPages}</div>
          </div>
        )}
      </div>
      )}
    </div>
  );
}
