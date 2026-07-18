import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useToast } from '@/hooks/use-toast';
import { useCan } from '@/hooks/use-can';
import { Pagination } from '@/components/ui/pagination';
import { createReport } from '@/lib/pdf-report';
import { exportToExcel } from '@/lib/excel-export';
import { logReportExportOrWarn } from '@/lib/report-export-log';
import { useExportLimit } from '@/hooks/use-export-limit';
import { useReportLabels } from '@/hooks/use-report-labels';

export function RetirementListPage() {
  const { formatDate } = useDatetimeFormat();
  const { toast } = useToast();
  const exportLimit = useExportLimit();
  const can = useCan();
  const { data, isLoading } = useSWR('/api/filters/retirements', { refreshInterval: 30000 });

  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const retirements = useMemo(() => {
    if (!Array.isArray(data)) return [];
    return data;
  }, [data]);

  // Filtered list driven by search
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return retirements;
    return retirements.filter((r: any) =>
      (r.name ?? '').toLowerCase().includes(q) ||
      (r.filterSet ?? '').toLowerCase().includes(q)
    );
  }, [retirements, search]);

  // Stats are always computed from the full dataset (not the filtered view)
  // so the operator sees the real picture at a glance regardless of search.
  const stats = useMemo(() => {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const startOfWeek = startOfToday - 6 * 24 * 60 * 60 * 1000;
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    let today = 0, week = 0, month = 0;
    for (const r of retirements) {
      const t = r.updatedAt ? new Date(r.updatedAt).getTime() : 0;
      if (!t) continue;
      if (t >= startOfToday) today++;
      if (t >= startOfWeek) week++;
      if (t >= startOfMonth) month++;
    }
    return { total: retirements.length, today, week, month };
  }, [retirements]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  // ─── Reports (PDF + Excel). Column headers + title come from the admin
  // report-labels config (key 'retirement-list'); both formats share one
  // head/rows builder so they never drift, and cover the full filtered set. ───
  const { labelsFor } = useReportLabels();
  const reportL = labelsFor('retirement-list');
  const REPORT_COLS = ['sNo', 'filter', 'set', 'retiredOn', 'retiredBy', 'remarks'];
  const reportHead = REPORT_COLS.map(k => reportL.columns[k]);
  const reportSubtitle = reportL.subtitle || `Total: ${filtered.length} retired filter${filtered.length === 1 ? '' : 's'}${search.trim() ? ` (filtered by "${search.trim()}")` : ''}`;
  // Phase 5C: retirement_list.export gate = ['RETIREMENT_LIST_EXPORT'] — SAME as old isSuperAdmin||RETIREMENT_LIST_EXPORT.
  const canExport = can('retirement_list.export');

  const [exporting, setExporting] = useState(false);
  const setLabel = (s: string | null | undefined) => s === 'SET_A' ? 'Set A' : s === 'SET_B' ? 'Set B' : (s ?? '-');
  const reportRows = (): string[][] => filtered.map((r: any, i: number) => [
    String(i + 1),
    r.name ?? '-',
    setLabel(r.filterSet),
    (r.retiredAt ?? r.updatedAt) ? formatDate(r.retiredAt ?? r.updatedAt) : '-',
    r.retiredBy ?? '-',
    r.remarks ?? '-',
  ]);

  const downloadReport = async () => {
    if (filtered.length === 0) { toast.error('Nothing to export', 'No retirements to include'); return; }
    if (filtered.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(filtered.length)); return; }
    setExporting(true);
    try {
      const report = await createReport({
        reportKey: 'retirement-list',
        title: reportL.title,
        subtitle: reportSubtitle,
        orientation: 'landscape',
        formatDateTime: (d: string) => formatDate(d),
      });
      report.addTable({ head: reportHead, body: reportRows(), columnStyles: { 0: { halign: 'center', cellWidth: 14 } } });
      await logReportExportOrWarn({ reportType: 'Retirement List', format: 'PDF', recordCount: filtered.length }, toast.warning);
      report.save('retirement-list.pdf');
    } catch (e: any) {
      toast.error('Export failed', e?.message ?? 'Could not generate the PDF report');
    } finally {
      setExporting(false);
    }
  };

  const downloadExcel = async () => {
    if (filtered.length === 0) { toast.error('Nothing to export', 'No retirements to include'); return; }
    if (filtered.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(filtered.length)); return; }
    try {
      await logReportExportOrWarn({ reportType: 'Retirement List', format: 'Excel', recordCount: filtered.length }, toast.warning);
      exportToExcel({ filename: 'retirement-list', sheetName: 'Retirements', head: reportHead, rows: reportRows() });
    } catch (e: any) {
      toast.error('Export failed', e?.message ?? 'Could not generate the Excel file');
    }
  };

  return (
    <div className="p-6 space-y-6">
      {/* ─── Header ─── */}
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 shadow-lg shadow-cyan-500/25">
          <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Retirement List</h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Filters that have been permanently retired and removed from service
          </p>
        </div>
      </div>

      {/* ─── Stat Cards ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-gradient-to-br from-teal-500 to-cyan-600 rounded-2xl p-4 text-white shadow-lg shadow-cyan-500/20">
          <div className="text-2xl font-bold">{stats.total}</div>
          <div className="text-cyan-100 text-sm font-medium mt-0.5">Total Retired</div>
        </div>
        <StatCard label="This Month" value={stats.month} iconBg="bg-amber-50" iconColor="text-amber-600" icon={
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        } />
        <StatCard label="This Week" value={stats.week} iconBg="bg-indigo-50" iconColor="text-indigo-600" icon={
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        } />
        <StatCard label="Today" value={stats.today} iconBg="bg-rose-50" iconColor="text-rose-600" icon={
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
        } />
      </div>

      {/* ─── Search ─── */}
      <div className="flex gap-3">
        <div className="relative flex-1 max-w-md">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={e => { setSearch(e.target.value); setPage(1); }}
            placeholder="Search filter name or set..."
            className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none transition-all"
          />
        </div>
        {canExport && (
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <button
            onClick={downloadExcel}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            title="Export the retirement list as an Excel file"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export Excel
          </button>
          <button
            onClick={downloadReport}
            disabled={exporting || filtered.length === 0}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-cyan-600 text-white text-sm font-semibold hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
            title="Download the retirement list as a PDF report"
          >
            {exporting ? (
              <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            )}
            {exporting ? 'Generating…' : 'Download Report'}
          </button>
        </div>
        )}
      </div>

      {/* ─── Table / States ─── */}
      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="h-1.5 bg-gradient-to-r from-teal-400 to-cyan-500" />
          <div className="p-4 space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-12 bg-slate-100 rounded-xl animate-pulse" />
            ))}
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="h-1.5 bg-gradient-to-r from-teal-400 to-cyan-500" />
          <div className="p-16 text-center">
            <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-gradient-to-br from-teal-50 to-cyan-50 flex items-center justify-center">
              <svg className="w-8 h-8 text-cyan-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <p className="text-slate-700 font-semibold">{search ? 'No matching retirements' : 'No retired filters yet'}</p>
            <p className="text-sm text-slate-400 mt-1">
              {search ? 'Try a different search term' : 'Filters that get retired will appear here'}
            </p>
          </div>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
          <div className="h-1.5 bg-gradient-to-r from-teal-400 to-cyan-500" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200">
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider w-16">S.No</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Filter</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Set</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Retired On</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Remarks</th>
                  <th className="text-left px-5 py-3.5 text-xs font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {pageItems.map((r: any, idx: number) => (
                  <tr key={r.id} className="hover:bg-cyan-50/40 transition-colors">
                    <td className="px-5 py-3.5 text-sm text-slate-400 font-medium">
                      {(safePage - 1) * pageSize + idx + 1}
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center shrink-0">
                          <svg className="w-4 h-4 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                          </svg>
                        </div>
                        <span className="text-sm font-semibold text-slate-800">{r.name ?? '-'}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      {r.filterSet ? (
                        <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg font-semibold bg-cyan-50 text-cyan-700 border border-cyan-100">
                          <span className="w-1.5 h-1.5 rounded-full bg-cyan-500" />
                          {r.filterSet === 'SET_A' ? 'Set A' : r.filterSet === 'SET_B' ? 'Set B' : r.filterSet}
                        </span>
                      ) : <span className="text-xs text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3.5 text-sm text-slate-600">{(r.retiredAt ?? r.updatedAt) ? formatDate(r.retiredAt ?? r.updatedAt) : '—'}</td>
                    <td className="px-5 py-3.5 text-sm text-slate-600 max-w-xs">
                      {r.remarks
                        ? <span className="block truncate" title={`${r.remarks}${r.retiredBy ? ` — by ${r.retiredBy}` : ''}`}>{r.remarks}</span>
                        : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full font-semibold bg-rose-50 text-rose-700 border border-rose-100">
                        <span className="w-1.5 h-1.5 rounded-full bg-rose-500" />
                        Retired
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination className="border-t border-slate-200 bg-slate-50/50" page={safePage} pageSize={pageSize} totalItems={filtered.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>
      )}
    </div>
  );
}

// ─── Local Helpers ────────────────────────────────────────

function StatCard({ label, value, iconBg, iconColor, icon }: {
  label: string; value: number; iconBg: string; iconColor: string; icon: React.ReactNode;
}) {
  return (
    <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
      <div className="flex items-center gap-3">
        <div className={`w-10 h-10 rounded-xl ${iconBg} flex items-center justify-center shrink-0`}>
          <svg className={`w-5 h-5 ${iconColor}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            {icon}
          </svg>
        </div>
        <div className="min-w-0">
          <div className="text-xl font-bold text-slate-800 leading-tight">{value}</div>
          <div className="text-xs text-slate-400 font-medium truncate">{label}</div>
        </div>
      </div>
    </div>
  );
}
