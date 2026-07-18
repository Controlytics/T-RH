import { useState, useMemo, Fragment } from 'react';
import useSWR, { mutate } from 'swr';
import { useReplacementFiltersEnabled } from '@/hooks/use-replacement-filters-enabled';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { apiClient } from '@/lib/api-client';
import { createReport } from '@/lib/pdf-report';
import { logReportExportOrWarn } from '@/lib/report-export-log';
import { useExportLimit } from '@/hooks/use-export-limit';
import { ExportMenu } from '@/components/ExportMenu';
import { SendForReviewButton } from '@/components/SendForReviewButton';
import { UploadValidationResult } from '@/components/upload-validation-result';
import { Pagination } from '@/components/ui/pagination';
import { themeButton } from '@/lib/theme-styles';
import { apiUrl } from '@/lib/url-utils';

// Show "NA" when a value wasn't entered (null/empty/whitespace) or was a stray
// "[object Object]" from a non-text spreadsheet cell.
const naText = (v: unknown): string => {
  const s = (v ?? '').toString().trim();
  return !s || s === '[object Object]' ? 'NA' : s;
};

// Filters belonging to one AHU — rendered inside an expanded Replacement
// Schedule row (gated per-role by SUPER_ADMIN). Lazy-fetched on expand.
function AhuFiltersRow({ ahuId, identMap }: { ahuId: string; identMap: Map<string, string[]> }) {
  const { data, isLoading } = useSWR<any>(ahuId ? `/api/hierarchy/filters?ahuId=${ahuId}&limit=200` : null);
  const filters: any[] = data?.data ?? [];
  if (isLoading) return <div className="px-8 py-3 text-[12px] text-slate-400">Loading filters…</div>;
  if (filters.length === 0) return <div className="px-8 py-3 text-[12px] text-slate-400">No filters under this AHU.</div>;
  return (
    <div className="px-8 py-3 bg-slate-50/70">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="[&>th]:text-left [&>th]:px-2 [&>th]:py-1 [&>th]:text-[11px] [&>th]:font-semibold [&>th]:text-slate-500 [&>th]:uppercase [&>th]:tracking-wider">
            <th>Filter</th><th>RFID</th><th>Micron</th><th>Filter Dimensions</th><th>Status</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {filters.map((f) => {
            const attrs = f.attributes ?? {};
            const rfid = (identMap.get(f.id) ?? []).join(', ');
            return (
              <tr key={f.id} className="[&>td]:px-2 [&>td]:py-1 text-slate-600">
                <td className="font-medium text-slate-800">{f.name}{f.filterSet ? <span className="ml-1.5 text-[10px] font-semibold text-indigo-500">Set {String(f.filterSet).replace('SET_', '')}</span> : null}</td>
                <td className="font-mono text-slate-500">{rfid || '—'}</td>
                <td>{naText(attrs.micronSize)}</td>
                <td>{naText(attrs.filterSize)}</td>
                <td>{(f.currentLifecycleState ?? 'To Be Cleaned').replace(/_/g, ' ')}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Group rows by AHU → Micron for the merged (rowspan) table layout. Sorts a
// copy by AHU → Micron → Filter Dimensions → date, then tags each row with its
// first-of-group flags + span counts. Used by both the schedule table and the
// upload preview so they render identically.
const byAhuMicronDim = (a: any, b: any) =>
  String(a.ahuName ?? '').localeCompare(String(b.ahuName ?? ''))
  || String(a.filterMicron ?? '').localeCompare(String(b.filterMicron ?? ''), undefined, { numeric: true })
  || String(a.filterSize ?? '').localeCompare(String(b.filterSize ?? ''), undefined, { numeric: true })
  || String(a.scheduleDate ?? '').localeCompare(String(b.scheduleDate ?? ''));

function buildMergeGroups(list: any[]) {
  let ahuOrdinal = 0; // running 1-based AHU number (merged S.No, one per AHU)
  return list.map((e: any, i: number) => {
    const prev = list[i - 1];
    const firstOfAhu = i === 0 || prev.ahuName !== e.ahuName;
    const lastOfAhu = i === list.length - 1 || list[i + 1].ahuName !== e.ahuName;
    const firstOfMicron = firstOfAhu || prev.filterMicron !== e.filterMicron;
    if (firstOfAhu) ahuOrdinal++;
    let ahuSpan = 0;
    if (firstOfAhu) for (let j = i; j < list.length && list[j].ahuName === e.ahuName; j++) ahuSpan++;
    let micronSpan = 0;
    if (firstOfMicron) for (let j = i; j < list.length && list[j].ahuName === e.ahuName && list[j].filterMicron === e.filterMicron; j++) micronSpan++;
    return { e, firstOfAhu, lastOfAhu, firstOfMicron, ahuSpan, micronSpan, ahuOrdinal };
  });
}

// Status chip colours (execution lifecycle)
const STATUS_CHIP: Record<string, string> = {
  PENDING: 'bg-slate-100 text-slate-500 border-slate-200',
  DUE: 'bg-amber-50 text-amber-700 border-amber-200',
  IN_PROGRESS: 'bg-blue-50 text-blue-700 border-blue-200',
  COMPLETED: 'bg-green-50 text-green-700 border-green-200',
  MISSED: 'bg-rose-50 text-rose-700 border-rose-200',
};

// Approval-workflow chip colours + labels.
const APPROVAL_CHIP: Record<string, { label: string; cls: string }> = {
  PENDING_REVIEW: { label: 'To Review', cls: 'bg-sky-50 text-sky-700 border-sky-200' },
  PENDING_APPROVAL: { label: 'To Approve', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  APPROVED: { label: 'Approved', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  REJECTED: { label: 'Rejected', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  PENDING: { label: 'Pending', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
};

export function ReplacementSchedulePage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const exportLimit = useExportLimit();
  const { formatDate } = useDatetimeFormat();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const perms = user?.permissions ?? [];
  const canUpload = isSuperAdmin || perms.includes('REPLACEMENT_SCHEDULE_UPLOAD');
  const canReview = isSuperAdmin || perms.includes('REPLACEMENT_SCHEDULE_REVIEW');
  const canApprove = isSuperAdmin || perms.includes('REPLACEMENT_SCHEDULE_APPROVE');
  const reauth = useReauth();
  const [busy, setBusy] = useState(false);
  const [rejectFor, setRejectFor] = useState<{ id: string; stage: 'review' | 'approval' } | null>(null);
  const [rejectRemarks, setRejectRemarks] = useState('');
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const { data, isLoading } = useSWR('/api/replacement-schedules', { refreshInterval: 30000 });
  const schedules = (data?.data ?? []) as any[];
  // Flatten ALL uploads into one combined list (no per-file separation).
  const allEntries = schedules
    .flatMap((s: any) => (s.entries ?? []).map((e: any) => ({ ...e, _uploadedByName: s.uploadedByName, _createdAt: s.createdAt })))
    // Grouped order: AHU → Micron → Filter Dimensions → date, so the merged
    // AHU / Micron cells below are built from contiguous rows.
    .sort((a: any, b: any) =>
      String(a.ahuName ?? '').localeCompare(String(b.ahuName ?? ''))
      || String(a.filterMicron ?? '').localeCompare(String(b.filterMicron ?? ''), undefined, { numeric: true })
      || String(a.filterSize ?? '').localeCompare(String(b.filterSize ?? ''), undefined, { numeric: true })
      || new Date(a.scheduleDate).getTime() - new Date(b.scheduleDate).getTime());
  const totalPages = Math.max(1, Math.ceil(allEntries.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pageEntries = allEntries.slice((safePage - 1) * pageSize, safePage * pageSize);

  // Per-page merge metadata (AHU / Micron rowspans). pageEntries is already
  // sorted in AHU → Micron → dimensions order, so buildMergeGroups just tags it.
  const groupedRows = buildMergeGroups(pageEntries);

  // ─── Workflow actions (reuse the PM workflow config; reauth-gated) ───
  const reviewApprove = (id: string) => {
    setBusy(true);
    reauth.execute('REVIEW_REPLACEMENT_SCHEDULE', async (pw?: string) => {
      const body = { entryIds: [id], action: 'approve' as const };
      if (pw) await apiClient.postWithReauth('/api/replacement-schedules/entries/review', body, pw);
      else await apiClient.post('/api/replacement-schedules/entries/review', body);
    }, { onSuccess: () => { toast.success('Reviewed', 'Sent for approval'); mutate('/api/replacement-schedules'); setBusy(false); }, onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setBusy(false); } });
  };
  const approve = (id: string) => {
    setBusy(true);
    reauth.execute('APPROVE_REPLACEMENT_SCHEDULE', async (pw?: string) => {
      const body = { entryIds: [id] };
      if (pw) await apiClient.postWithReauth('/api/replacement-schedules/entries/approve', body, pw);
      else await apiClient.post('/api/replacement-schedules/entries/approve', body);
    }, { onSuccess: () => { toast.success('Approved', 'Entry approved'); mutate('/api/replacement-schedules'); setBusy(false); }, onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setBusy(false); } });
  };
  const submitReject = () => {
    if (!rejectFor || rejectRemarks.trim().length < 3) return;
    const { id, stage } = rejectFor;
    setBusy(true);
    const action = stage === 'review' ? 'REVIEW_REPLACEMENT_SCHEDULE' : 'REJECT_REPLACEMENT_SCHEDULE';
    reauth.execute(action, async (pw?: string) => {
      const url = stage === 'review' ? '/api/replacement-schedules/entries/review' : '/api/replacement-schedules/entries/reject';
      const body = stage === 'review' ? { entryIds: [id], action: 'reject' as const, remarks: rejectRemarks.trim() } : { entryIds: [id], remarks: rejectRemarks.trim() };
      if (pw) await apiClient.postWithReauth(url, body, pw);
      else await apiClient.post(url, body);
    }, { onSuccess: () => { toast.success('Rejected', 'Entry rejected'); setRejectFor(null); mutate('/api/replacement-schedules'); setBusy(false); }, onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setBusy(false); } });
  };

  const exportExcel = async () => {
    setExporting(true);
    try {
      if (allEntries.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(allEntries.length)); return; }
      await logReportExportOrWarn({ reportType: 'Replacement Schedule', format: 'Excel', recordCount: allEntries.length }, toast.warning);
      const res = await fetch(apiUrl('/api/replacement-schedules/export.xlsx'), { headers: { Authorization: `Bearer ${sessionStorage.getItem('access_token')}` } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'replacement-schedule.xlsx';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e: any) { toast.error('Export failed', e?.message ?? 'Could not download'); } finally { setExporting(false); }
  };
  const buildReplacementReport = async () => {
    const all = schedules.flatMap((s: any) => (s.entries ?? []));
    if (all.length === 0) { toast.error('Nothing to export', 'No replacement entries'); return null; }
    if (all.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(all.length)); return null; }
    const report = await createReport({ reportKey: 'replacement-schedule', title: 'Replacement Schedule', subtitle: `Total: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}`, orientation: 'landscape', formatDateTime: (d: string) => formatDate(d) });
    report.addTable({
      head: ['S.No', 'AHU', 'Micron', 'Filter Dimensions', 'Qty', 'Date', 'Status', 'Uploaded By', 'Reviewed By', 'Approved By'],
      body: all.map((e: any, i: number) => [String(e.slNo ?? i + 1), e.ahuName ?? '-', naText(e.filterMicron), naText(e.filterSize), String(e.qty), e.scheduleDate ? formatDate(e.scheduleDate) : '-', (APPROVAL_CHIP[e.approvalStatus]?.label ?? e.approvalStatus ?? '-'), e.submittedByName ?? '-', e.reviewedByName ?? '-', e.approvedByName ?? '-']),
      columnStyles: { 0: { halign: 'center', cellWidth: 14 } },
    });
    return report;
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      const report = await buildReplacementReport();
      if (!report) return;
      await logReportExportOrWarn({ reportType: 'Replacement Schedule', format: 'PDF', recordCount: schedules.flatMap((s: any) => (s.entries ?? [])).length }, toast.warning);
      report.save('replacement-schedule.pdf');
    } catch (e: any) { toast.error('Export failed', e?.message ?? 'Could not generate PDF'); } finally { setExporting(false); }
  };

  const buildReplacementSnapshot = async () => { const report = await buildReplacementReport(); return report ? report.getSnapshot() : null; };

  // Upload dialog state
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<'select' | 'preview' | 'uploading' | 'results'>('select');
  const [file, setFile] = useState<File | null>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [error, setError] = useState('');
  const [created, setCreated] = useState(0);
  const [failed, setFailed] = useState(0);

  // Per-role "show AHU filters" feature (SUPER_ADMIN configurable).
  const filtersEnabled = useReplacementFiltersEnabled();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpand = (id: string) => setExpanded((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const { data: identsData } = useSWR<any>(filtersEnabled ? '/api/assets/identifiers' : null);
  const identMap = useMemo(() => {
    const m = new Map<string, string[]>();
    const list: any[] = identsData?.data ?? (Array.isArray(identsData) ? identsData : []);
    for (const it of list) {
      if (it.identifierType !== 'RFID') continue;
      const arr = m.get(it.assetId) ?? [];
      arr.push(it.identifierValue);
      m.set(it.assetId, arr);
    }
    return m;
  }, [identsData]);

  const resetDialog = () => {
    setStep('select'); setFile(null); setRows([]); setResults([]); setError(''); setCreated(0); setFailed(0);
  };
  const openDialog = () => { resetDialog(); setOpen(true); };
  const closeDialog = () => setOpen(false);

  const token = () => sessionStorage.getItem('access_token');

  const downloadTemplate = async () => {
    try {
      const res = await fetch(apiUrl('/api/replacement-schedules/template.xlsx'), { headers: { Authorization: `Bearer ${token()}` } });
      if (!res.ok) { toast.error('Download failed', res.status === 401 ? 'Session expired.' : `HTTP ${res.status}`); return; }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'replacement-schedule-template.xlsx'; a.style.display = 'none';
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (e: any) { toast.error('Download failed', e?.message ?? 'Network error'); }
  };

  const onFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setFile(f); setError(''); setResults([]);
    try {
      const fd = new FormData(); fd.append('file', f);
      const res = await fetch(apiUrl('/api/replacement-schedules/validate'), { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) { setError(d.message || `Could not read file (HTTP ${res.status})`); return; }
      setRows(d.rows || []); setResults(d.results || []); setStep('preview');
    } catch (e: any) { setError(e?.message || 'Failed to read the file'); }
  };

  const submit = async () => {
    if (!file) return;
    setStep('uploading');
    try {
      const fd = new FormData(); fd.append('file', file);
      const res = await fetch(apiUrl('/api/replacement-schedules'), { method: 'POST', headers: { Authorization: `Bearer ${token()}` }, body: fd });
      const d = await res.json().catch(() => ({}));
      if (!res.ok && !Array.isArray(d.results)) { setError(d.message || `Upload failed (HTTP ${res.status})`); setStep('preview'); return; }
      setResults(d.results || []); setCreated(d.created || 0); setFailed(d.failed || 0); setStep('results');
      if ((d.created || 0) > 0) { mutate('/api/replacement-schedules'); toast.success('Schedule uploaded', `${d.created} entr${d.created === 1 ? 'y' : 'ies'} created`); }
    } catch (e: any) { setError(e?.message || 'Network error'); setStep('preview'); }
  };

  const errorRows = results.filter((r: any) => r.status === 'error');
  // Upload preview, grouped/merged the same way as the saved schedule table.
  const previewGroups = buildMergeGroups([...rows].sort(byAhuMicronDim));

  return (
    <div className="py-6 space-y-6 -mx-3 sm:-mx-4 lg:-mx-6 px-3 sm:px-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-slate-800">Replacement Schedule</h1>
          <p className="text-sm text-slate-500 mt-0.5">{allEntries.length} scheduled replacement(s)</p>
        </div>
        <div className="flex items-center gap-2">
          <ExportMenu surface="replacement" onExportPdf={exportPdf} onExportExcel={exportExcel} busy={exporting}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 shadow-sm transition-all disabled:opacity-50" />
          <SendForReviewButton buildSnapshot={buildReplacementSnapshot}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 shadow-sm transition-all" />
          <button onClick={downloadTemplate}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg text-xs font-semibold border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 shadow-sm transition-all">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5 5-5M12 15V3" /></svg>
            Download Template
          </button>
          {canUpload && (
            <button onClick={openDialog}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-white rounded-lg text-xs font-semibold shadow-sm hover:shadow-md transition-all" style={themeButton}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" /></svg>
              Upload Schedule
            </button>
          )}
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div className="bg-white border border-slate-200 rounded-xl p-16 text-center text-sm text-slate-400">Loading…</div>
      ) : allEntries.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-16 text-center">
          <p className="text-slate-600 font-medium mb-1">No replacement schedule yet</p>
          <p className="text-sm text-slate-400">{canUpload ? 'Upload a schedule template to get started.' : 'No schedule has been uploaded.'}</p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-xl overflow-hidden shadow-sm">
          <div className="px-4 py-3 border-b border-slate-100 bg-slate-50/60 flex items-center justify-between">
            <div className="text-sm font-semibold text-slate-700">Replacement Schedule <span className="text-slate-400 font-normal">· {allEntries.length} entr{allEntries.length === 1 ? 'y' : 'ies'}</span></div>
            {schedules[0] && <div className="text-[11px] text-slate-400">last upload by {schedules[0].uploadedByName ?? '—'} · {formatDate(schedules[0].createdAt)}</div>}
          </div>
          <div className="overflow-auto max-h-[calc(100vh-22rem)]">
            <table className="w-full border-collapse">
              <thead className="sticky top-0 z-10">
                <tr className="bg-slate-50 [&>th]:bg-slate-100 [&>th]:border [&>th]:border-slate-300 [&>th]:whitespace-nowrap [&>th]:text-left [&>th]:px-3 [&>th]:py-2 [&>th]:text-[11px] [&>th]:font-semibold [&>th]:text-slate-600 [&>th]:uppercase [&>th]:tracking-wider">
                  <th className="w-12 text-center">S.No</th>
                  <th>AHU Name</th>
                  <th className="text-center">Filter Micron</th>
                  <th>Filter Dimensions</th>
                  <th className="text-center">Qty</th>
                  <th>Schedule Date</th>
                  <th className="text-center">Tolerance Days</th>
                  <th>Status</th>
                  <th>Approval</th>
                  <th className="text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {groupedRows.map(({ e, firstOfAhu, lastOfAhu, firstOfMicron, ahuSpan, micronSpan, ahuOrdinal }: any) => (
                  <Fragment key={e.id}>
                  <tr className="[&>td]:border [&>td]:border-slate-200 [&>td]:whitespace-nowrap [&>td]:px-3 [&>td]:py-2 [&>td]:text-sm hover:bg-slate-50/40">
                    {firstOfAhu && (
                      <td rowSpan={ahuSpan} className="text-center text-slate-500 font-medium align-top bg-slate-50/50">{ahuOrdinal}</td>
                    )}
                    {firstOfAhu && (
                      <td rowSpan={ahuSpan} className="font-medium text-slate-800 max-w-[200px] align-top bg-slate-50/50 border-l-2 border-teal-100" title={e.ahuName}>
                        {filtersEnabled && e.ahuId ? (
                          <button onClick={() => toggleExpand(e.ahuId)} className="inline-flex items-center gap-1.5 hover:text-teal-600 transition-colors max-w-full">
                            <svg className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${expanded.has(e.ahuId) ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                            <span className="truncate">{e.ahuName}</span>
                          </button>
                        ) : <span className="truncate block">{e.ahuName}</span>}
                      </td>
                    )}
                    {firstOfMicron && (
                      <td rowSpan={micronSpan} className="text-center text-slate-700 font-medium align-top bg-slate-50/30">{naText(e.filterMicron)}</td>
                    )}
                    <td className="text-slate-600 max-w-[160px] truncate" title={naText(e.filterSize)}>{naText(e.filterSize)}</td>
                    <td className="text-center text-slate-700">{e.qty}</td>
                    <td className="text-slate-600">{formatDate(e.scheduleDate)}</td>
                    <td className="text-center text-slate-600">{e.toleranceDays}</td>
                    <td><span className={`text-[11px] px-2.5 py-1 rounded-full border font-medium ${STATUS_CHIP[e.computedStatus] ?? STATUS_CHIP.PENDING}`}>{(e.computedStatus ?? 'PENDING').replace(/_/g, ' ')}</span></td>
                    <td><span className={`text-[11px] px-2.5 py-1 rounded-full border font-medium ${(APPROVAL_CHIP[e.approvalStatus] ?? APPROVAL_CHIP.APPROVED).cls}`}>{(APPROVAL_CHIP[e.approvalStatus] ?? APPROVAL_CHIP.APPROVED).label}</span></td>
                    <td className="text-right">
                      <div className="inline-flex items-center gap-1.5 justify-end">
                        {canReview && e.approvalStatus === 'PENDING_REVIEW' && (
                          <>
                            <button onClick={() => reviewApprove(e.id)} disabled={busy} className="px-2.5 py-1 bg-sky-500 text-white text-[11px] font-semibold rounded-md hover:bg-sky-600 disabled:opacity-50">Review ✓</button>
                            <button onClick={() => { setRejectFor({ id: e.id, stage: 'review' }); setRejectRemarks(''); }} disabled={busy} className="px-2.5 py-1 bg-red-500 text-white text-[11px] font-semibold rounded-md hover:bg-red-600 disabled:opacity-50">Reject</button>
                          </>
                        )}
                        {canApprove && (e.approvalStatus === 'PENDING_APPROVAL' || e.approvalStatus === 'PENDING') && (
                          <>
                            <button onClick={() => approve(e.id)} disabled={busy} className="px-2.5 py-1 bg-emerald-500 text-white text-[11px] font-semibold rounded-md hover:bg-emerald-600 disabled:opacity-50">Approve</button>
                            <button onClick={() => { setRejectFor({ id: e.id, stage: 'approval' }); setRejectRemarks(''); }} disabled={busy} className="px-2.5 py-1 bg-red-500 text-white text-[11px] font-semibold rounded-md hover:bg-red-600 disabled:opacity-50">Reject</button>
                          </>
                        )}
                        {e.approvalStatus === 'REJECTED' && e.approvalRemarks && (
                          <span className="text-[11px] text-rose-600 italic max-w-[160px] truncate" title={e.approvalRemarks}>{e.approvalRemarks}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                  {filtersEnabled && lastOfAhu && expanded.has(e.ahuId) && e.ahuId && (
                    <tr>
                      <td colSpan={10} className="p-0">
                        <AhuFiltersRow ahuId={e.ahuId} identMap={identMap} />
                      </td>
                    </tr>
                  )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination className="border-t border-slate-100 bg-slate-50/60" page={safePage} pageSize={pageSize} totalItems={allEntries.length} onPageChange={setPage} onPageSizeChange={setPageSize} />
        </div>
      )}

      {/* Upload dialog */}
      {open && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[55] p-4">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col shadow-2xl">
            <div className="px-6 py-4 shrink-0 flex items-center justify-between" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
              <div>
                <h2 className="text-lg font-bold text-white">Upload Replacement Schedule</h2>
                <p className="text-white/70 text-sm">Excel (.xlsx) with the template columns</p>
              </div>
              <button onClick={closeDialog} className="text-white/80 hover:text-white">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              </button>
            </div>
            <div className="p-6 space-y-4 overflow-y-auto flex-1">
              {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}

              {step === 'select' && (
                <div className="space-y-3">
                  <label className="block">
                    <span className="block text-sm font-medium text-slate-700 mb-1">Schedule file (.xlsx)</span>
                    <input type="file" accept=".xlsx" onChange={onFileSelect} className="block w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-cyan-50 file:text-cyan-700 file:font-semibold hover:file:bg-cyan-100" />
                  </label>
                </div>
              )}

              {step === 'preview' && (
                <div className="space-y-3">
                  <div className="text-sm text-slate-600">
                    {errorRows.length === 0
                      ? <span className="text-green-700 font-medium">{rows.length} row(s) ready — no errors.</span>
                      : <span className="text-rose-700 font-medium">{errorRows.length} error(s) found — fix and re-upload (nothing is saved until all rows are valid).</span>}
                  </div>
                  <div className="border border-slate-200 rounded-lg overflow-auto max-h-[40vh]">
                    <table className="w-full text-[12px] border-collapse">
                      <thead className="sticky top-0 bg-slate-50"><tr className="[&>th]:bg-slate-100 [&>th]:border [&>th]:border-slate-300 [&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left [&>th]:font-semibold [&>th]:text-slate-600 [&>th]:whitespace-nowrap">
                        <th className="text-center">S.No</th><th>AHU Name</th><th className="text-center">Filter Micron</th><th>Filter Dimensions</th><th>Qty</th><th>Schedule Date</th><th className="text-center">Tolerance Days</th>
                      </tr></thead>
                      <tbody>
                        {previewGroups.map(({ e: r, firstOfAhu, firstOfMicron, ahuSpan, micronSpan, ahuOrdinal }: any, i: number) => (
                          <tr key={i} className="[&>td]:border [&>td]:border-slate-200 [&>td]:px-2 [&>td]:py-1.5 [&>td]:whitespace-nowrap">
                            {firstOfAhu && <td rowSpan={ahuSpan} className="text-center text-slate-500 font-medium align-top bg-slate-50/50">{ahuOrdinal}</td>}
                            {firstOfAhu && <td rowSpan={ahuSpan} className="font-medium text-slate-800 align-top bg-slate-50/50 border-l-2 border-teal-100">{r.ahuName}</td>}
                            {firstOfMicron && <td rowSpan={micronSpan} className="text-center text-slate-700 font-medium align-top bg-slate-50/30">{r.filterMicron}</td>}
                            <td>{r.filterSize}</td><td>{r.qty}</td><td>{r.scheduleDate}</td><td className="text-center">{r.toleranceDays}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {errorRows.length > 0 && (
                    <div className="border border-rose-200 rounded-lg bg-rose-50/50 p-2 max-h-[20vh] overflow-auto text-[12px] text-rose-700 space-y-0.5">
                      {errorRows.map((er: any, i: number) => <div key={i}>Row {er.row}{er.column ? ` · ${er.column}` : ''}: {er.error}</div>)}
                    </div>
                  )}
                </div>
              )}

              {step === 'uploading' && <div className="text-center py-8 text-sm text-slate-500">Uploading…</div>}

              {step === 'results' && (
                <UploadValidationResult
                  importedCount={created}
                  importedLabel="Created"
                  errors={(results ?? []).filter((r: any) => r.status === 'error').map((r: any) => ({ row: r.row, reason: r.error ?? 'Failed', column: r.column, value: r.value }))}
                />
              )}
            </div>
            <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
              <button onClick={closeDialog} className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100">{step === 'results' ? 'Close' : 'Cancel'}</button>
              {step === 'preview' && (
                <button onClick={submit} disabled={errorRows.length > 0}
                  className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white disabled:opacity-50 disabled:cursor-not-allowed" style={themeButton}>
                  Upload {rows.length} row(s)
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Reject dialog (review or approval stage) */}
      {rejectFor && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[56] p-4">
          <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md p-5 shadow-2xl">
            <h3 className="text-lg font-bold text-slate-800 mb-1">Reject Entry</h3>
            <p className="text-sm text-slate-500 mb-3">Remarks are required (min 3 characters).</p>
            <textarea value={rejectRemarks} onChange={(e) => setRejectRemarks(e.target.value)} rows={3}
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-cyan-500/30" placeholder="Reason for rejection…" />
            <div className="flex gap-2 mt-3">
              <button onClick={() => setRejectFor(null)} className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200">Cancel</button>
              <button onClick={submitReject} disabled={busy || rejectRemarks.trim().length < 3}
                className="flex-1 py-2 bg-red-500 text-white rounded-lg text-sm font-semibold hover:bg-red-600 disabled:opacity-50">Reject</button>
            </div>
          </div>
        </div>
      )}

      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setBusy(false); }}
        actionLabel="Replacement Schedule Action" />
    </div>
  );
}
