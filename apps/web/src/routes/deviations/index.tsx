import { useState } from 'react';
import useSWR from 'swr';
import { useCan } from '@/hooks/use-can';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Pagination } from '@/components/ui/pagination';
import { apiClient } from '@/lib/api-client';
import { createReport } from '@/lib/pdf-report';
import { exportToExcel } from '@/lib/excel-export';
import { logReportExportOrWarn } from '@/lib/report-export-log';
import { useExportLimit } from '@/hooks/use-export-limit';
import { ExportMenu } from '@/components/ExportMenu';
import { SendForReviewButton } from '@/components/SendForReviewButton';
import { useToast } from '@/hooks/use-toast';

interface DeviationRow {
  id: string;
  deviationNumber: string;
  ahuName: string;
  filterCount: number;
  scheduledDate: string;
  windowEnd: string;
  overdueDaysAtOpen: number;
  liveOverdueDays: number;
  status: 'OPEN' | 'ACKNOWLEDGED' | 'CLOSED';
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  passwordVerified: boolean;
  completedByName: string | null;
  completedAt: string | null;
  delayDays: number | null;
  closedAt: string | null;
  createdAt: string;
}

interface DeviationResponse {
  data: DeviationRow[];
  total: number;
  openCount: number;
  page: number;
  limit: number;
  totalPages: number;
}

const STATUS_META: Record<DeviationRow['status'], { label: string; cls: string; dot: string }> = {
  OPEN:         { label: 'Open',         cls: 'bg-rose-50 text-rose-700 border-rose-200',       dot: 'bg-rose-500' },
  ACKNOWLEDGED: { label: 'Acknowledged', cls: 'bg-amber-50 text-amber-700 border-amber-200',    dot: 'bg-amber-500' },
  CLOSED:       { label: 'Closed',       cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
};

const TABS: { key: string; label: string }[] = [
  { key: 'ALL', label: 'All' },
  { key: 'OPEN', label: 'Open' },
  { key: 'ACKNOWLEDGED', label: 'Acknowledged' },
  { key: 'CLOSED', label: 'Closed' },
];

// Overdue / delay severity bands (2026-06-10): ≤7 days yellow, 8–30 orange, >30 red.
// Rendered as filled badge pills (not thin text) with a wide hue gap so the three
// bands are easy to tell apart. Same scale colours the columns and the legend.
function severityCls(days: number | null | undefined): string {
  const n = days ?? 0;
  if (n > 30) return 'bg-red-100 text-red-700 border-red-300';
  if (n > 7) return 'bg-orange-100 text-orange-700 border-orange-300';
  return 'bg-yellow-100 text-yellow-800 border-yellow-400';
}
const severityPill = `inline-block px-2 py-0.5 rounded-md text-[12px] font-semibold border`;
const SEVERITY_BANDS: { dot: string; label: string }[] = [
  { dot: 'bg-yellow-400', label: '≤ 7 days' },
  { dot: 'bg-orange-500', label: '8–30 days' },
  { dot: 'bg-red-600',    label: '> 30 days' },
];

// Full "N day(s)" label instead of the terse "Nd".
function daysLabel(n: number | null | undefined): string {
  const v = n ?? 0;
  return `${v} day${v === 1 ? '' : 's'}`;
}

export function DeviationsPage() {
  const can = useCan();
  const { toast } = useToast();
  const exportLimit = useExportLimit();
  const { formatDate, formatDateTime } = useDatetimeFormat();
  const [status, setStatus] = useState('ALL');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  // Report download (period-scoped PDF).
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [downloadMsg, setDownloadMsg] = useState('');

  const params = new URLSearchParams({ page: String(page), limit: String(pageSize) });
  if (status !== 'ALL') params.set('status', status);
  const { data, isLoading } = useSWR<DeviationResponse>(`/api/pm-schedules/deviations?${params}`, { refreshInterval: 30000 });

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  const HEAD = ['Deviation #', 'AHU', 'Filters', 'Scheduled', 'Overdue', 'Status', 'Acknowledged By', 'Completed By', 'Completed', 'Delay'];

  // Fetch every page for the current status tab, filter by the selected period,
  // and build the export rows. Shared by the PDF + Excel export. Returns null
  // (and surfaces a message) when there's nothing to export.
  const buildDeviationsExport = async (): Promise<{ body: string[][]; period: string; total: number } | null> => {
    const all: DeviationRow[] = [];
    let p = 1;
    let totalPages = 1;
    do {
      const qp = new URLSearchParams({ page: String(p), limit: '200' });
      if (status !== 'ALL') qp.set('status', status);
      const resp = await apiClient.get<DeviationResponse>(`/api/pm-schedules/deviations?${qp}`);
      all.push(...(resp.data ?? []));
      totalPages = resp.totalPages ?? 1;
      p++;
    } while (p <= totalPages);

    const fromT = fromDate ? new Date(`${fromDate}T00:00:00`).getTime() : -Infinity;
    const toT = toDate ? new Date(`${toDate}T23:59:59`).getTime() : Infinity;
    const filtered = all.filter(d => {
      const t = new Date(d.scheduledDate).getTime();
      return t >= fromT && t <= toT;
    });
    if (filtered.length === 0) { setDownloadMsg('No deviations in the selected period.'); return null; }
    if (filtered.length > exportLimit.maxRecords) { setDownloadMsg(exportLimit.tooLargeMessage(filtered.length)); return null; }

    const period = fromDate || toDate
      ? `${fromDate ? formatDate(fromDate) : 'Start'} to ${toDate ? formatDate(toDate) : 'Now'}`
      : 'All Time';
    const body = filtered.map(d => [
      d.deviationNumber, d.ahuName, String(d.filterCount), formatDate(d.scheduledDate),
      d.status === 'CLOSED' ? `${daysLabel(d.delayDays ?? d.overdueDaysAtOpen)} delay` : daysLabel(d.liveOverdueDays),
      STATUS_META[d.status].label, d.acknowledgedByName ?? '-', d.completedByName ?? '-',
      d.completedAt ? formatDateTime(d.completedAt) : '-', d.delayDays != null ? daysLabel(d.delayDays) : '-',
    ]);
    return { body, period, total: filtered.length };
  };

  const buildDeviationsReport = async () => {
    const r = await buildDeviationsExport();
    if (!r) return null;
    const report = await createReport({ reportKey: 'deviations',
      title: 'Deviations Report',
      subtitle: `Status: ${status === 'ALL' ? 'All' : STATUS_META[status as DeviationRow['status']]?.label ?? status}  |  Period: ${r.period}  |  Total: ${r.total} deviation(s)`,
      orientation: 'landscape',
      formatDateTime,
    });
    report.addTable({ head: HEAD, body: r.body, headColor: [225, 29, 72] });
    return { report, count: r.body.length };
  };

  const exportPdf = async () => {
    setDownloading(true); setDownloadMsg('');
    try {
      const built = await buildDeviationsReport();
      if (!built) return;
      await logReportExportOrWarn({ reportType: 'Deviations', format: 'PDF', recordCount: built.count }, toast.warning);
      built.report.save(`deviations-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e: any) {
      setDownloadMsg(e?.message ?? 'Failed to generate the report.');
    } finally { setDownloading(false); }
  };

  const buildDeviationsSnapshot = async () => { const built = await buildDeviationsReport(); return built ? built.report.getSnapshot() : null; };

  const exportExcel = async () => {
    setDownloading(true); setDownloadMsg('');
    try {
      const r = await buildDeviationsExport();
      if (!r) return;
      await logReportExportOrWarn({ reportType: 'Deviations', format: 'Excel', recordCount: r.body.length }, toast.warning);
      exportToExcel({ filename: `deviations-${new Date().toISOString().slice(0, 10)}`, sheetName: 'Deviations', head: HEAD, rows: r.body });
    } catch (e: any) {
      setDownloadMsg(e?.message ?? 'Failed to generate the report.');
    } finally { setDownloading(false); }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-100 bg-white shrink-0">
        <div className="flex items-center gap-3 mb-4">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-rose-500 to-rose-600 shadow-lg shadow-rose-600/10">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-800 tracking-tight">Deviations</h1>
            <p className="text-[13px] text-slate-400 mt-0.5">
              {total.toLocaleString()} deviation{total === 1 ? '' : 's'}
              {data?.openCount ? ` · ${data.openCount} open` : ''} — overdue AHU filter cleaning audit trail
            </p>
          </div>
        </div>

        {/* Overdue severity legend */}
        <div className="flex items-center gap-4 mb-3 text-[11px]">
          <span className="font-bold text-slate-400 uppercase tracking-wider">Overdue / Delay</span>
          {SEVERITY_BANDS.map(b => (
            <span key={b.label} className="flex items-center gap-1.5 text-slate-500">
              <span className={`w-2.5 h-2.5 rounded-full ${b.dot}`} />{b.label}
            </span>
          ))}
        </div>

        {/* Tabs + report download toolbar */}
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex gap-2 flex-wrap">
            {TABS.map(t => (
              <button key={t.key} onClick={() => { setStatus(t.key); setPage(1); }}
                className={`px-3.5 py-1.5 rounded-full text-[12px] font-semibold transition-all ${status === t.key ? 'bg-rose-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}>
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-[11px] font-medium text-slate-400">From</label>
            <input type="date" value={fromDate} onChange={e => { setFromDate(e.target.value); setDownloadMsg(''); }}
              className="border border-slate-200 rounded-lg px-2 py-1 text-[12px] text-slate-700 focus:border-rose-400 focus:ring-2 focus:ring-rose-100 outline-none" />
            <label className="text-[11px] font-medium text-slate-400">To</label>
            <input type="date" value={toDate} onChange={e => { setToDate(e.target.value); setDownloadMsg(''); }}
              className="border border-slate-200 rounded-lg px-2 py-1 text-[12px] text-slate-700 focus:border-rose-400 focus:ring-2 focus:ring-rose-100 outline-none" />
            {/* Phase 5C: Export gated on deviations.export (gate: PM_READ).
                Previously UNGATED (fail-open); now correctly hidden from users without PM_READ. */}
            {can('deviations.export') && (
              <ExportMenu surface="deviations" onExportPdf={exportPdf} onExportExcel={exportExcel} busy={downloading}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-gradient-to-r from-rose-500 to-rose-600 shadow-sm shadow-rose-600/20 disabled:opacity-50" />
            )}
            <SendForReviewButton buildSnapshot={buildDeviationsSnapshot}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 border border-slate-200 bg-white hover:bg-slate-50" />
          </div>
        </div>
        {downloadMsg && <div className="mt-2 text-[12px] text-rose-600">{downloadMsg}</div>}
      </div>

      {/* Table */}
      <div className="flex-1 overflow-auto px-6 py-4">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-2 border-rose-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-slate-400">Loading deviations...</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <svg className="w-14 h-14 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-slate-400 font-medium text-[14px]">No deviations</span>
            <span className="text-[13px] text-slate-300">Overdue AHU cleaning tasks appear here automatically</span>
          </div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-xl bg-white">
            <table className="w-full">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 border-b border-slate-200">
                  {['Deviation #', 'AHU', 'Filters', 'Scheduled', 'Overdue', 'Status', 'Acknowledged By', 'Completed By', 'Completed', 'Delay'].map((h, i) => (
                    <th key={i} className="text-left px-4 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(d => {
                  const sm = STATUS_META[d.status];
                  return (
                    <tr key={d.id} className="hover:bg-rose-50/20 transition-colors">
                      <td className="px-4 py-3 text-[13px] font-semibold text-slate-800 whitespace-nowrap">{d.deviationNumber}</td>
                      <td className="px-4 py-3 text-[13px] text-slate-700">{d.ahuName}</td>
                      <td className="px-4 py-3 text-[13px] text-slate-600 text-center tabular-nums">{d.filterCount}</td>
                      <td className="px-4 py-3 text-[13px] text-slate-600 whitespace-nowrap">{formatDate(d.scheduledDate)}</td>
                      <td className="px-4 py-3 text-[13px] whitespace-nowrap">
                        {d.status === 'CLOSED' ? (
                          <span className={`${severityPill} ${severityCls(d.delayDays ?? d.overdueDaysAtOpen)}`}>
                            {daysLabel(d.delayDays ?? d.overdueDaysAtOpen)} delay
                          </span>
                        ) : (
                          <span className={`${severityPill} ${severityCls(d.liveOverdueDays)}`}>
                            {daysLabel(d.liveOverdueDays)}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold rounded-full border ${sm.cls}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${sm.dot}`} />{sm.label}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-[13px] text-slate-700 whitespace-nowrap">
                        {d.acknowledgedByName ?? '—'}
                        {d.passwordVerified && <span className="ml-1 text-emerald-500" title="Password verified">✓</span>}
                      </td>
                      <td className="px-4 py-3 text-[13px] text-slate-700 whitespace-nowrap">{d.completedByName ?? '—'}</td>
                      <td className="px-4 py-3 text-[13px] text-slate-600 whitespace-nowrap">{d.completedAt ? formatDateTime(d.completedAt) : '—'}</td>
                      <td className="px-4 py-3 text-[13px] text-center tabular-nums">
                        {d.delayDays != null
                          ? <span className={`${severityPill} ${severityCls(d.delayDays)}`}>{daysLabel(d.delayDays)}</span>
                          : <span className="text-slate-600">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Pagination */}
      {rows.length > 0 && (
        <div className="border-t border-slate-200 bg-white shrink-0">
          <Pagination page={page} pageSize={pageSize} totalItems={total} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>
      )}
    </div>
  );
}
