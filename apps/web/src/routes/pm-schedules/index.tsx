import React, { useRef, useState, useMemo } from 'react';
import useSWR, { mutate as globalMutate } from 'swr';
import { apiClient } from '../../lib/api-client';
import { useAuth } from '../../hooks/use-auth';
import { useCan } from '../../hooks/use-can';
import { useReauth } from '../../hooks/use-reauth';
import { ReauthDialog } from '../../components/reauth-dialog';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { usePmFiltersEnabled } from '../../hooks/use-pm-filters-enabled';
import { Pagination } from '@/components/ui/pagination';
import { createReport } from '../../lib/pdf-report';
import { ExportMenu } from '@/components/ExportMenu';
import { SendForReviewButton } from '@/components/SendForReviewButton';
import { UploadValidationResult } from '@/components/upload-validation-result';
import { logReportExportOrWarn } from '@/lib/report-export-log';
import { useExportLimit } from '@/hooks/use-export-limit';
import { isoToDateInput } from '@/lib/datetime-input';
import { apiUrl } from '@/lib/url-utils';

interface UploadResult {
  imported: number;
  skipped: number;
  details: {
    imported: Array<{ row: number; ahuName: string; plannedDate: string; scheduleId: string; entryId: string }>;
    skipped: Array<{ row: number; reason: string; data?: any }>;
  };
}

interface ScheduleEntry {
  id: string; scheduleId: string; ahuId: string; ahuName: string;
  month: number; plannedDate: string; toleranceDays: number;
  windowStart: string; windowEnd: string;
  approvalStatus: 'PENDING' | 'PENDING_REVIEW' | 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED';
  approvalRemarks: string | null;
  approvedByName: string | null; approvedAt: string | null;
  submittedByName: string | null;
  reviewedByName?: string | null; reviewedAt?: string | null; reviewRemarks?: string | null;
  rejectedByName?: string | null; rejectedAt?: string | null; rejectionStage?: string | null;
  pendingPlannedDate: string | null; pendingToleranceDays: number | null;
}

interface PastDateEntry { ahuName: string; scheduledDate: string }

const STATUS_CFG: Record<string, { label: string; bg: string; text: string; border: string; dot: string }> = {
  PENDING:  { label: 'Pending',  bg: 'bg-amber-50',   text: 'text-amber-700',   border: 'border-amber-200',   dot: 'bg-amber-400 animate-pulse' },
  PENDING_REVIEW:   { label: 'To Review',   bg: 'bg-sky-50',    text: 'text-sky-700',    border: 'border-sky-200',    dot: 'bg-sky-400 animate-pulse' },
  PENDING_APPROVAL: { label: 'To Approve',  bg: 'bg-amber-50',  text: 'text-amber-700',  border: 'border-amber-200',  dot: 'bg-amber-400 animate-pulse' },
  APPROVED: { label: 'Approved', bg: 'bg-emerald-50',  text: 'text-emerald-700',  border: 'border-emerald-200',  dot: 'bg-emerald-400' },
  REJECTED: { label: 'Rejected', bg: 'bg-red-50',      text: 'text-red-700',      border: 'border-red-200',      dot: 'bg-red-400' },
};

function parseCsvText(text: string): Array<Record<string, string>> {
  const lines = text.split(/\r?\n/).filter(l => l.trim() && !l.trim().startsWith('#'));
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',');
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] ?? '').trim(); });
    return obj;
  });
}

function findPastDates(rows: Array<Record<string, string>>): PastDateEntry[] {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const past: PastDateEntry[] = [];
  for (const row of rows) {
    const ahuName = (row.ahu_name ?? row.ahuName ?? row.AHU ?? row['AHU Name'] ?? '').trim();
    const rawDate = (row.scheduled_date ?? row.scheduledDate ?? row.date ?? row['Scheduled Date'] ?? '').trim();
    if (!ahuName || !rawDate) continue;
    const isoMatch = rawDate.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
    const dmyMatch = !isoMatch ? rawDate.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/) : null;
    let d: Date | null = null;
    if (isoMatch) d = new Date(Number(isoMatch[1]), Number(isoMatch[2]) - 1, Number(isoMatch[3]));
    else if (dmyMatch) d = new Date(Number(dmyMatch[3]), Number(dmyMatch[2]) - 1, Number(dmyMatch[1]));
    if (d && d < today) past.push({ ahuName, scheduledDate: rawDate });
  }
  return past;
}

export function PmScheduleListPage() {
  const { user } = useAuth();
  const { toast } = useToast();
  const exportLimit = useExportLimit();
  const { formatDate, formatDateTime, config: datetimeConfig } = useDatetimeFormat();
  const datetimeTz = datetimeConfig.timezone;
  const [exporting, setExporting] = useState(false);
  const reauth = useReauth();
  // Runtime-facing PM settings; the admin /api/config/dynamic/pm-schedule-settings
  // endpoint is SUPER_ADMIN-gated and 401s for operators/admins, so the page can't
  // read its own gating flag. Mirrors the cleaning-reasons / field-options dual-
  // endpoint pattern. Audit finding F-2 (High) — 2026-05-29.
  const { data: pmConfig } = useSWR('/api/pm-schedules/settings');

  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [result, setResult] = useState<UploadResult | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pastDateWarning, setPastDateWarning] = useState<PastDateEntry[] | null>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // Permission flags
  // Phase 5C: simple per-action gates resolve from the PERMISSION_TREE via useCan(<node>)
  // (node gates narrowed to the per-action UI perm). isSuperAdmin/perms are RETAINED below
  // because the review/approve flags use config-driven workflow-ROLE logic that useCan cannot
  // express (gate on role === configured approver/reviewer role, not a static permission).
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const perms = user?.permissions ?? [];
  const can = useCan();
  const canDownload = can('pm.download_template');
  const canUpload = can('pm.upload');
  const canEditEntry = can('pm.edit_entry');
  const canResubmit = can('pm.resubmit');
  // 3-step workflow config. When the workflow is ON, the backend gates review/approve
  // strictly by the configured ROLE (assertPmRole), so the FE must too — otherwise a
  // user with the PM_APPROVE permission but not the approver role sees an Approve
  // button that 403s. When OFF (legacy single-step), fall back to the permissions.
  const { data: wfConfig } = useSWR<{ workflowEnabled: boolean; reviewRole: string; approvalRole: string }>('/api/pm-schedules/workflow-config');
  const workflowOn = wfConfig?.workflowEnabled ?? false;
  const isApprover = isSuperAdmin || (workflowOn ? user?.role === wfConfig?.approvalRole : perms.includes('PM_APPROVE'));
  const canReview = isSuperAdmin || (workflowOn ? user?.role === wfConfig?.reviewRole : perms.includes('PM_REVIEW'));
  // Audit 2026-05-09 fix: PM schedule DELETE was an orphan endpoint
  // (BE supports it with reauth, no FE caller). Surface a delete button
  // per AHU group; backend pm-schedule-crud.ts:138 returns 409 if any
  // execution is IN_PROGRESS, which surfaces as a clean toast.
  // PM schedule delete is SUPER_ADMIN-only (pm.delete gate is [] post-Phase-3 M4) — useCan SA-bypass.
  const canDeleteSchedule = can('pm.delete');
  // Audit 2026-05-09 fix: BE supports POST /api/pm-schedules with reauth
  // (CREATE_PM_SCHEDULE) but the only path was bulk CSV upload — operators
  // wanting one-off schedules had to hand-build a CSV.
  const canCreateSchedule = can('pm.create');

  // Table state
  const [statusFilter, setStatusFilter] = useState('ALL');
  const now = new Date();
  const [dateFrom, setDateFrom] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`);
  const [dateTo, setDateTo] = useState(() => {
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return `${end.getFullYear()}-${String(end.getMonth() + 1).padStart(2, '0')}-${String(end.getDate()).padStart(2, '0')}`;
  });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rejectDialog, setRejectDialog] = useState<string[] | null>(null);
  const [rejectRemarks, setRejectRemarks] = useState('');
  const [rejectStage, setRejectStage] = useState<'review' | 'approval'>('approval');
  const [processing, setProcessing] = useState(false);
  const [deleteScheduleConfirm, setDeleteScheduleConfirm] = useState<{ scheduleId: string; ahuName: string } | null>(null);
  const [deletingSchedule, setDeletingSchedule] = useState(false);
  // 2026-07-16: single-date PM schedule. Operator picks AHU + one date
  // (year/month/day) + tolerance; FE posts ONE entry. The backend 409s if the
  // AHU already has an active schedule for that year (one PM per AHU per year).
  const [createDialog, setCreateDialog] = useState(false);
  const [createForm, setCreateForm] = useState({
    ahuId: '',
    plannedDate: '',
    toleranceDays: 7,
  });
  // Set when the chosen AHU already has an active schedule for the chosen year —
  // drives the "overwrite?" confirmation. `approved` gates the pending-edit path:
  // only an APPROVED entry can be overwritten (its date stays active while the
  // change goes through review → approval); a not-yet-approved entry must first
  // be resolved in the review/approval queue.
  const [overwriteConfirm, setOverwriteConfirm] = useState<
    { entryId: string; approved: boolean; existingDate: string; year: number; ahuName: string } | null
  >(null);
  const [creatingSchedule, setCreatingSchedule] = useState(false);

  // Pagination
  const paginationOptions = usePaginationConfig();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0] ?? 10);

  // Expandable AHU rows — show/hide filters. Gated per-role by the dedicated
  // "PM Schedule — AHU Filters" matrix (separate from the Replacement Schedule
  // one), fail-closed: hidden unless SUPER_ADMIN enabled this role.
  const ahuFiltersEnabled = usePmFiltersEnabled();
  const [expandedAhus, setExpandedAhus] = useState<Set<string>>(new Set());
  const toggleAhuExpand = (ahuId: string) => {
    setExpandedAhus(prev => { const n = new Set(prev); if (n.has(ahuId)) n.delete(ahuId); else n.add(ahuId); return n; });
  };

  // Inline edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editTolerance, setEditTolerance] = useState('');

  // Data fetching — filter by date range.
  // The endpoint is per-year, so a range that SPANS years must fetch each one:
  // deriving a single `year` from dateFrom silently dropped every entry in the
  // later year(s) of a Dec→Feb range. Years come from a string slice, not
  // `new Date(dateFrom).getFullYear()` — that parses as UTC midnight and would
  // report the previous year for any zone west of UTC.
  const fromYear = Number(dateFrom.slice(0, 4));
  const toYear = Number(dateTo.slice(0, 4));
  const years = useMemo(() => {
    if (!Number.isFinite(fromYear) || !Number.isFinite(toYear) || toYear < fromYear) return [fromYear].filter(Number.isFinite);
    // Guard a typo'd year (e.g. '20226') from fanning out into thousands of requests.
    const span = Math.min(toYear - fromYear, 10);
    return Array.from({ length: span + 1 }, (_, i) => fromYear + i);
  }, [fromYear, toYear]);

  // limit=2000 so the whole year's entries load (the page has no pagination UI;
  // the old default of 50 hid most records in the ALL view).
  const statusQs = statusFilter !== 'ALL' ? `&approvalStatus=${statusFilter}` : '';
  const entriesUrls = useMemo(
    () => years.map(y => `/api/pm-schedules/entries?year=${y}&limit=2000${statusQs}`),
    [years, statusQs],
  );
  const entriesKey = entriesUrls.length ? (['pm-entries', ...entriesUrls] as const) : null;
  const { data: entriesData, isLoading } = useSWR(
    entriesKey,
    async ([, ...urls]: readonly string[]) => {
      const pages = await Promise.all(urls.map(u => apiClient.get<{ data: ScheduleEntry[] }>(u)));
      return { data: pages.flatMap(p => p?.data ?? []) };
    },
    { refreshInterval: 15000 },
  );
  // Client-side filter entries to the selected date range. The day key must be
  // read in the operator's zone: slicing the stored UTC instant puts a
  // 2026-07-16 00:30 IST entry on 2026-07-15 and drops it at a range edge.
  const allEntries: ScheduleEntry[] = entriesData?.data ?? [];
  const entries = allEntries.filter(e => {
    const d = isoToDateInput(e.plannedDate, datetimeTz);
    if (!d) return true;
    return d >= dateFrom && d <= dateTo;
  });
  const { data: countsData } = useSWR('/api/pm-schedules/entries/pending-counts');
  const pendingCount = countsData?.pending ?? 0;
  const rejectedCount = countsData?.rejected ?? 0;

  const refreshAll = () => {
    if (entriesKey) globalMutate(entriesKey);
    globalMutate('/api/pm-schedules/entries/pending-counts');
  };

  // PM disabled check moved below all hooks (was here before; the early return
  // skipped the useSWR + useMemo hooks defined further down → React error #300).

  const handleDownloadTemplate = async () => {
    try {
      const res = await fetch(`${(window as any).__API_BASE__ ?? ''}/api/pm-schedules/template.csv`, {
        headers: { Authorization: `Bearer ${sessionStorage.getItem('access_token') ?? ''}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = 'pm-schedule-template.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    } catch (e: any) { setUploadError(`Failed to download template: ${e.message ?? 'unknown error'}`); }
  };

  // ─── Schedule export (PDF + Excel) with the upload/review/approve trail ───
  const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Label for the selected span — a cross-year range must not be titled (or
  // filenamed) with just its first year.
  const yearLabel = years.length > 1 ? `${years[0]}-${years[years.length - 1]}` : String(years[0]);

  // Fetch ALL entries across EVERY year in the range (all statuses), paging
  // past the 200 cap. The endpoint is per-year, so the span is fetched year by
  // year — exporting only `fromYear`'s entries dropped the rest in silence.
  const fetchAllEntries = async (): Promise<any[]> => {
    const all: any[] = [];
    for (const y of years) {
      let p = 1;
      while (p <= 100) {
        const res: any = await apiClient.get(`/api/pm-schedules/entries?year=${y}&page=${p}&limit=200`);
        const batch: any[] = res?.data ?? [];
        all.push(...batch);
        const total: number = res?.total ?? batch.length;
        if (batch.length === 0 || p * 200 >= total) break;
        p++;
      }
    }
    return all;
  };

  const buildPmReport = async () => {
    const all = await fetchAllEntries();
    if (all.length === 0) { toast.error('Nothing to export', `No PM schedule entries for ${yearLabel}`); return null; }
    if (all.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(all.length)); return null; }
    const report = await createReport({ reportKey: 'pm-schedule',
      title: `PM Schedule ${yearLabel}`,
      subtitle: `Total: ${all.length} entr${all.length === 1 ? 'y' : 'ies'}`,
      orientation: 'landscape',
      formatDateTime,
    });
    report.addTable({
      head: ['S.No', 'AHU', 'Month', 'Planned', 'Tol', 'Status', 'Uploaded By', 'Reviewed By', 'Approved By', 'Remarks'],
      body: all.map((e, i) => [
        String(i + 1), e.ahuName ?? '-', MONTH_ABBR[(e.month ?? 1) - 1] ?? String(e.month),
        e.plannedDate ? formatDate(e.plannedDate) : '-', String(e.toleranceDays ?? '-'),
        STATUS_CFG[e.approvalStatus]?.label ?? e.approvalStatus,
        e.submittedByName ?? '-', e.reviewedByName ?? '-', e.approvedByName ?? '-',
        e.approvalRemarks ?? e.reviewRemarks ?? '-',
      ]),
      columnStyles: { 0: { halign: 'center', cellWidth: 14 }, 9: { cellWidth: 45 } },
    });
    return { report, count: all.length };
  };

  const exportPdf = async () => {
    setExporting(true);
    try {
      const built = await buildPmReport();
      if (!built) return;
      await logReportExportOrWarn({ reportType: 'PM Schedule', format: 'PDF', recordCount: built.count }, toast.warning);
      built.report.save(`pm-schedule-${yearLabel}.pdf`);
    } catch (e: any) {
      toast.error('Export failed', e?.message ?? 'Could not generate PDF');
    } finally { setExporting(false); }
  };

  const buildPmSnapshot = async () => { const built = await buildPmReport(); return built ? built.report.getSnapshot() : null; };

  const exportExcel = async () => {
    setExporting(true);
    try {
      if (allEntries.length > exportLimit.maxRecords) { toast.error('Export too large', exportLimit.tooLargeMessage(allEntries.length)); return; }
      await logReportExportOrWarn({ reportType: 'PM Schedule', format: 'Excel', recordCount: allEntries.length }, toast.warning);
      const base = (window as any).__API_BASE__ ?? '';
      // The server builds one workbook per year, so a cross-year range
      // downloads one file per year. Exporting only `fromYear` would drop the
      // rest without saying so.
      for (const y of years) {
        const res = await fetch(`${base}/api/pm-schedules/entries/export.xlsx?year=${y}`, {
          headers: { Authorization: `Bearer ${sessionStorage.getItem('access_token') ?? ''}` },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = `pm-schedule-${y}.xlsx`;
        document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
      }
    } catch (e: any) {
      toast.error('Export failed', e?.message ?? 'Could not download Excel');
    } finally { setExporting(false); }
  };

  // Audit 2026-05-09 fix: bulk upload was a high-trust mutation with no
  // password challenge. SUPER_ADMIN uploads auto-approve every row
  // (pm-import.ts:133). Reauth gate matches the BE-side enforceReauth
  // added on the same commit.
  const uploadFile = (file: File) => {
    setUploading(true); setUploadError(''); setResult(null);
    reauth.execute(
      'UPLOAD_PM_SCHEDULES',
      async (password?: string) => {
        const form = new FormData(); form.append('file', file);
        const token = sessionStorage.getItem('access_token') ?? '';
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (password) headers['x-reauth-password'] = password;
        const res = await fetch(apiUrl('/api/pm-schedules/upload'), { method: 'POST', headers, body: form });
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          // Throw with the server's structured error so reauth.execute can
          // re-prompt on REAUTH_REQUIRED / REAUTH_FAILED, otherwise treat as
          // a real upload failure.
          const err: any = new Error(body?.message ?? `Upload failed (HTTP ${res.status})`);
          err.code = body?.error;
          throw err;
        }

        // Auto-widen the date range + force statusFilter=ALL so the freshly
        // uploaded entries are actually visible in the table below. Without
        // this, operators see "Uploaded (Pending QA): N" but the table is
        // empty because (a) the page defaults to the CURRENT MONTH only,
        // (b) the year filter derives from dateFrom (so a 2027 upload is
        // invisible from a 2026 view), and (c) non-superadmin uploads are
        // PENDING but the operator may have an APPROVED tab selected.
        const uploaded = (body as UploadResult)?.details?.imported ?? [];
        if (uploaded.length > 0) {
          const dates = uploaded.map(r => r.plannedDate).sort();
          const uploadedMin = dates[0];
          const uploadedMax = dates[dates.length - 1];
          if (uploadedMin < dateFrom) setDateFrom(uploadedMin);
          if (uploadedMax > dateTo) setDateTo(uploadedMax);
          if (statusFilter !== 'ALL') setStatusFilter('ALL');
        }

        setResult(body as UploadResult);
      },
      {
        onSuccess: () => { refreshAll(); setUploading(false); },
        onError: (e: any) => { setUploadError(e?.message ?? 'Upload failed'); setUploading(false); },
      },
    );
  };

  const handleFile = async (file: File) => {
    setUploadError(''); setResult(null);
    if (file.name.endsWith('.csv')) {
      try {
        const text = await file.text();
        const rows = parseCsvText(text);
        const past = findPastDates(rows);
        if (past.length > 0) { setPastDateWarning(past); setPendingFile(file); return; }
      } catch { /* let server handle */ }
    }
    uploadFile(file);
  };

  const onDrop = (e: React.DragEvent) => { e.preventDefault(); setDragActive(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); };

  // ─── Approval actions ───

  const handleApprove = (ids: string[]) => {
    setProcessing(true);
    reauth.execute('APPROVE_PM_SCHEDULE', async (password?: string) => {
      if (password) await apiClient.postWithReauth('/api/pm-schedules/entries/approve', { entryIds: ids }, password);
      else await apiClient.post('/api/pm-schedules/entries/approve', { entryIds: ids });
    }, {
      onSuccess: () => { toast.success('Approved', `${ids.length} entry(s) approved`); setSelected(new Set()); refreshAll(); setProcessing(false); },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setProcessing(false); },
    });
  };

  // A-01 Wave 3 / Phase 3 (2026-05-29): migrated off /api/assets/instances +
  // /api/assets/templates to /api/hierarchy/* (typed-table reads). The
  // hierarchy endpoint already returns only AHU-kind rows, so no template
  // detection / heuristic / Set-membership filtering is needed in this file.
  // `instances` is still fetched (legacy asset list) because the per-AHU
  // filter-name lookup further down (around line ~449) walks instance
  // parentId chains. That lookup is part of the deferred filter-list.tsx /
  // filter-operations.tsx migration; once those land we can drop this call.
  const { data: instancesData } = useSWR('/api/assets/instances');
  const instances = (instancesData?.data ?? []) as any[];

  const { data: ahuListData } = useSWR('/api/hierarchy/ahus?limit=500');
  const ahuList = (ahuListData?.data ?? []) as Array<{ id: string; name: string }>;

  // Review step (3-step workflow): send a reviewed entry on to approval.
  const handleReviewApprove = (ids: string[]) => {
    setProcessing(true);
    reauth.execute('REVIEW_PM_SCHEDULE', async (password?: string) => {
      const body = { entryIds: ids, action: 'approve' as const };
      if (password) await apiClient.postWithReauth('/api/pm-schedules/entries/review', body, password);
      else await apiClient.post('/api/pm-schedules/entries/review', body);
    }, {
      onSuccess: () => { toast.success('Reviewed', `${ids.length} entry(s) sent for approval`); setSelected(new Set()); refreshAll(); setProcessing(false); },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setProcessing(false); },
    });
  };

  // Reject opener — stage 'review' rejects at the review step, 'approval' at approval.
  const handleReject = (ids: string[], stage: 'review' | 'approval' = 'approval') => {
    setRejectDialog(ids); setRejectRemarks(''); setRejectStage(stage);
  };

  const submitReject = () => {
    if (!rejectDialog || !rejectRemarks.trim()) return;
    const ids = rejectDialog;
    const stage = rejectStage;
    setProcessing(true);
    const reauthAction = stage === 'review' ? 'REVIEW_PM_SCHEDULE' : 'REJECT_PM_SCHEDULE';
    reauth.execute(reauthAction, async (password?: string) => {
      const url = stage === 'review' ? '/api/pm-schedules/entries/review' : '/api/pm-schedules/entries/reject';
      const body = stage === 'review'
        ? { entryIds: ids, action: 'reject' as const, remarks: rejectRemarks.trim() }
        : { entryIds: ids, remarks: rejectRemarks.trim() };
      if (password) await apiClient.postWithReauth(url, body, password);
      else await apiClient.post(url, body);
    }, {
      onSuccess: () => { toast.success('Rejected', `${ids.length} entry(s) rejected`); setRejectDialog(null); setSelected(new Set()); refreshAll(); setProcessing(false); },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setProcessing(false); },
    });
  };

  // 2026-07-16: single-date PM schedule create. One entry on the chosen date,
  // one PM per AHU per year. On submit we first check whether the AHU already
  // has an active schedule for that year; if so we ask to overwrite (PUT =
  // archive-then-recreate) rather than surfacing the backend 409.
  const resetCreate = () => {
    setCreateDialog(false);
    setCreatingSchedule(false);
    setCreateForm({ ahuId: '', plannedDate: '', toleranceDays: 7 });
  };

  // Single entry derived from the current form (month/year come from the date).
  const formEntry = () => {
    const [yStr, mStr] = createForm.plannedDate.split('-');
    return { year: Number(yStr), month: Number(mStr) };
  };

  // POST — new schedule (reauth CREATE_PM_SCHEDULE). Used when the AHU has none.
  const doCreate = (year: number, month: number) => {
    const body = {
      entityId: createForm.ahuId,
      year,
      entries: [{ month, plannedDate: createForm.plannedDate, toleranceDays: createForm.toleranceDays }],
    };
    setCreatingSchedule(true);
    reauth.execute(
      'CREATE_PM_SCHEDULE',
      async (password?: string) => {
        if (password) await apiClient.postWithReauth('/api/pm-schedules', body, password);
        else await apiClient.post('/api/pm-schedules', body);
      },
      {
        onSuccess: () => {
          toast.success('Created', `PM schedule created for ${createForm.plannedDate}`);
          resetCreate();
          refreshAll();
        },
        onError: (e: any) => {
          toast.error('Error', e?.message ?? 'Failed to create schedule');
          setCreatingSchedule(false);
        },
      },
    );
  };

  // Overwrite = a pending EDIT on the existing APPROVED entry. The current date
  // stays active and keeps generating PM tasks; the new date is staged as a
  // pending change that goes through review → approval (and mints a QNN). reauth
  // EDIT_PM_SCHEDULE. Called from the overwrite-confirm dialog.
  const doOverwrite = (entryId: string) => {
    const body = { plannedDate: createForm.plannedDate, toleranceDays: createForm.toleranceDays };
    setCreatingSchedule(true);
    reauth.execute(
      'EDIT_PM_SCHEDULE',
      async (password?: string) => {
        if (password) await apiClient.putWithReauth(`/api/pm-schedules/entries/${entryId}/edit`, body, password);
        else await apiClient.put(`/api/pm-schedules/entries/${entryId}/edit`, body);
      },
      {
        onSuccess: () => {
          toast.success('Sent for review', `Change to ${createForm.plannedDate} submitted for review & approval. The current date stays active until approved.`);
          setOverwriteConfirm(null);
          resetCreate();
          refreshAll();
        },
        onError: (e: any) => {
          toast.error('Error', e?.message ?? 'Failed to submit the change');
          setCreatingSchedule(false);
        },
      },
    );
  };

  const submitCreateSchedule = async () => {
    if (!createForm.ahuId || !createForm.plannedDate) return;
    const { year, month } = formEntry();
    if (!year || !month) return;
    setCreatingSchedule(true);
    // Does this AHU already have an active schedule for the chosen year?
    // getByEntity returns the schedule (200) or null (200) — a throw means a
    // real network/permission error, in which case we let the create attempt
    // surface it rather than silently blocking.
    let existing: any = null;
    try {
      existing = await apiClient.get(`/api/pm-schedules/${createForm.ahuId}?year=${year}`);
    } catch { /* treat as "no existing" and let create() report any real error */ }
    setCreatingSchedule(false);
    const firstEntry = existing && Array.isArray(existing.entries) && existing.entries.length > 0 ? existing.entries[0] : null;
    if (existing && existing.id && firstEntry) {
      const existingDate = firstEntry.plannedDate ? isoToDateInput(firstEntry.plannedDate, datetimeTz) : String(year);
      const ahuName = ahuInstances.find((a: any) => a.id === createForm.ahuId)?.name ?? 'this AHU';
      setOverwriteConfirm({
        entryId: firstEntry.id,
        approved: firstEntry.approvalStatus === 'APPROVED',
        existingDate,
        year,
        ahuName,
      });
      return;
    }
    doCreate(year, month);
  };

  // AHU dropdown source for the create-schedule dialog. Reads from
  // /api/hierarchy/ahus directly (typed-table endpoint, A-01 Wave 5
  // migration). Returned shape is { id, name, ... } per ahu — no kind
  // filtering needed (endpoint only returns AHU-kind rows by design).
  const ahuInstances = useMemo(() => ahuList, [ahuList]);

  // Audit 2026-05-09 fix: PM schedule DELETE was an orphan endpoint —
  // BE supports it with reauth (DELETE_PM_SCHEDULE), no FE caller. The
  // service blocks delete with 409 if any execution is IN_PROGRESS
  // (pm-schedule-crud.ts:138, deliberate soft-lock); operators see a
  // clean toast in that case.
  const submitDeleteSchedule = () => {
    if (!deleteScheduleConfirm) return;
    const { scheduleId, ahuName } = deleteScheduleConfirm;
    setDeletingSchedule(true);
    reauth.execute(
      'DELETE_PM_SCHEDULE',
      async (password?: string) => {
        if (password) await apiClient.deleteWithReauth(`/api/pm-schedules/${scheduleId}`, password);
        else await apiClient.delete(`/api/pm-schedules/${scheduleId}`);
      },
      {
        onSuccess: () => {
          toast.success('Deleted', `Schedule for "${ahuName}" deleted`);
          setDeleteScheduleConfirm(null); setDeletingSchedule(false); refreshAll();
        },
        onError: (e: any) => {
          const msg = e?.code === 'IN_PROGRESS' || /in progress/i.test(e?.message ?? '')
            ? `Cannot delete — "${ahuName}" has a PM execution in progress. Wait for it to complete.`
            : (e?.message ?? 'Failed to delete schedule');
          toast.error('Error', msg);
          setDeletingSchedule(false);
        },
      },
    );
  };

  // Audit 2026-05-09 fix: resubmit flips REJECTED → PENDING. Approve and
  // reject already reauth — gate this for parity so all three lifecycle
  // transitions on a PM entry are challengeable.
  const handleResubmit = (id: string) => {
    if (!editDate) return;
    setProcessing(true);
    const body = {
      plannedDate: editDate,
      ...(editTolerance ? { toleranceDays: Number(editTolerance) } : {}),
    };
    reauth.execute(
      'RESUBMIT_PM_ENTRY',
      async (password?: string) => {
        if (password) await apiClient.postWithReauth(`/api/pm-schedules/entries/${id}/resubmit`, body, password);
        else await apiClient.post(`/api/pm-schedules/entries/${id}/resubmit`, body);
      },
      {
        onSuccess: () => {
          toast.success('Re-submitted', 'Entry sent for QA approval');
          setEditingId(null); refreshAll(); setProcessing(false);
        },
        onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setProcessing(false); },
      },
    );
  };

  const handleEdit = async (id: string) => {
    if (!editDate) return;
    setProcessing(true);
    reauth.execute('EDIT_PM_SCHEDULE', async (password?: string) => {
      const body = { plannedDate: editDate, ...(editTolerance ? { toleranceDays: Number(editTolerance) } : {}) };
      if (password) await apiClient.putWithReauth(`/api/pm-schedules/entries/${id}/edit`, body, password);
      else await apiClient.put(`/api/pm-schedules/entries/${id}/edit`, body);
    }, {
      onSuccess: () => { toast.success('Edit Submitted', 'Change sent for QA approval'); setEditingId(null); refreshAll(); setProcessing(false); },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setProcessing(false); },
    });
  };

  // Reviewer modifies a PENDING_REVIEW entry in place (stays in review).
  const handleReviewEdit = async (id: string) => {
    if (!editDate) return;
    setProcessing(true);
    reauth.execute('REVIEW_PM_SCHEDULE', async (password?: string) => {
      const body = { plannedDate: editDate, ...(editTolerance ? { toleranceDays: Number(editTolerance) } : {}) };
      if (password) await apiClient.putWithReauth(`/api/pm-schedules/entries/${id}/review-edit`, body, password);
      else await apiClient.put(`/api/pm-schedules/entries/${id}/review-edit`, body);
    }, {
      onSuccess: () => { toast.success('Modified', 'Schedule updated (still awaiting review approval)'); setEditingId(null); refreshAll(); setProcessing(false); },
      onError: (e: any) => { toast.error('Error', e?.message ?? 'Failed'); setProcessing(false); },
    });
  };

  const toggleSelect = (id: string) => {
    setSelected(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  };
  const pendingEntries = entries.filter(e => e.approvalStatus === 'PENDING');
  const allPendingSelected = pendingEntries.length > 0 && pendingEntries.every(e => selected.has(e.id));
  const toggleSelectAll = () => {
    if (allPendingSelected) setSelected(new Set());
    else setSelected(new Set(pendingEntries.map(e => e.id)));
  };

  // (instancesData fetched earlier — used by both the AHU-dropdown create
  // dialog and the filter-name lookup below.)

  // Paginate entries first, then group by AHU
  const totalEntries = entries.length;
  const paginatedEntries = useMemo(() => {
    const start = (page - 1) * perPage;
    return entries.slice(start, start + perPage);
  }, [entries, page, perPage]);

  // PM disabled check — must run AFTER all hooks above to avoid React error #300
  // ("rendered fewer hooks than expected") when the config arrives async and
  // the page short-circuits on the second render.
  if (pmConfig && !(pmConfig as any).enabled) {
    return (
      <div className="p-6">
        <div className="bg-white border border-slate-200 rounded-2xl p-16 text-center shadow-sm">
          <h2 className="text-xl font-semibold text-slate-700 mb-2">PM Module Disabled</h2>
          <p className="text-slate-500">Enable Preventive Maintenance scheduling in Configuration settings.</p>
        </div>
      </div>
    );
  }

  // Group paginated entries by AHU for display
  const groupedEntries: Array<{ ahuName: string; ahuId: string; entries: ScheduleEntry[]; filterNames: string[] }> = [];
  const ahuMap = new Map<string, ScheduleEntry[]>();
  for (const e of paginatedEntries) {
    if (!ahuMap.has(e.ahuId)) ahuMap.set(e.ahuId, []);
    ahuMap.get(e.ahuId)!.push(e);
  }
  for (const [ahuId, ahuEntries] of ahuMap) {
    const filterNames = instances
      .filter((inst: any) => inst.parentId === ahuId)
      .map((inst: any) => inst.name);
    groupedEntries.push({ ahuId, ahuName: ahuEntries[0].ahuName, entries: ahuEntries, filterNames });
  }

  // Summary stats
  const approvedCount = entries.filter(e => e.approvalStatus === 'APPROVED').length;
  const pendingInView = entries.filter(e => e.approvalStatus === 'PENDING' || e.approvalStatus === 'PENDING_REVIEW' || e.approvalStatus === 'PENDING_APPROVAL').length;
  const rejectedInView = entries.filter(e => e.approvalStatus === 'REJECTED').length;
  const colCount = (isApprover ? 1 : 0) + 8;

  return (
    <div className="p-6 space-y-6">
      {/* ─── Header ─── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-4">
          <div className="p-3.5 rounded-2xl shadow-lg" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800 tracking-tight">PM Schedules</h1>
            <p className="text-sm text-slate-400 mt-0.5">Preventive maintenance cleaning schedules</p>
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          {canDownload && (
            <button onClick={handleDownloadTemplate} className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50 hover:border-slate-300 transition-all">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              Template
            </button>
          )}
          <ExportMenu surface="pm" onExportPdf={exportPdf} onExportExcel={exportExcel} busy={exporting}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50 hover:border-slate-300 transition-all disabled:opacity-50" />
          <SendForReviewButton buildSnapshot={buildPmSnapshot}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50 hover:border-slate-300 transition-all" />
          {canCreateSchedule && (
            <button onClick={() => setCreateDialog(true)}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 transition-colors">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
              New Schedule
            </button>
          )}
          {canUpload && (
            <button onClick={() => { setUploadOpen(true); setResult(null); setUploadError(''); }} className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-semibold shadow-md hover:shadow-lg transition-all" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))', color: '#fff' }}>
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.9A5.001 5.001 0 0115.9 6a5 5 0 01.1 10H7zM9 15l3-3m0 0l3 3m-3-3v6" /></svg>
              Upload Schedule
            </button>
          )}
        </div>
      </div>

      {/* ─── Summary Cards ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">Total</p>
          <p className="text-2xl font-bold text-slate-800 mt-0.5">{totalEntries}</p>
        </div>
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-emerald-500 uppercase tracking-wider">Approved</p>
          <p className="text-2xl font-bold text-emerald-700 mt-0.5">{approvedCount}</p>
        </div>
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-amber-500 uppercase tracking-wider">Pending</p>
          <p className="text-2xl font-bold text-amber-700 mt-0.5">{pendingInView}</p>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3">
          <p className="text-[11px] font-semibold text-red-400 uppercase tracking-wider">Rejected</p>
          <p className="text-2xl font-bold text-red-600 mt-0.5">{rejectedInView}</p>
        </div>
      </div>

      {/* ─── Filters Bar ─── */}
      <div className="bg-white border border-slate-200 rounded-xl px-5 py-3.5 flex items-center gap-5 flex-wrap">
        {/* Date range */}
        <div className="flex items-center gap-2.5">
          <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
          <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setSelected(new Set()); setPage(1); }}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 bg-slate-50 focus:bg-white focus:ring-2 transition-all"
            style={{ '--tw-ring-color': 'var(--theme-focus-ring)' } as any} />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setSelected(new Set()); setPage(1); }}
            className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-700 bg-slate-50 focus:bg-white focus:ring-2 transition-all"
            style={{ '--tw-ring-color': 'var(--theme-focus-ring)' } as any} />
        </div>
        {/* Separator */}
        <div className="h-6 w-px bg-slate-200" />
        {/* Status tabs */}
        <div className="flex items-center gap-1.5">
          {['ALL', 'PENDING_REVIEW', 'PENDING_APPROVAL', 'PENDING', 'APPROVED', 'REJECTED'].map(s => {
            const count = s === 'ALL' ? totalEntries : entries.filter(e => e.approvalStatus === s).length;
            // Hide the legacy "Pending" tab and empty review/approval tabs to
            // reduce clutter (kept visible when it's the active filter).
            if (s !== 'ALL' && s !== 'APPROVED' && s !== 'REJECTED' && count === 0 && statusFilter !== s) return null;
            return (
              <button key={s} onClick={() => { setStatusFilter(s); setSelected(new Set()); setPage(1); }}
                className={`px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all ${statusFilter === s
                  ? 'text-white shadow-sm'
                  : 'bg-slate-50 text-slate-500 hover:bg-slate-100 border border-slate-200'}`}
                style={statusFilter === s ? { backgroundColor: 'var(--theme-primary)', color: '#fff' } : undefined}>
                {s === 'ALL' ? 'All' : STATUS_CFG[s]?.label ?? s}
                {count > 0 && <span className={`ml-1.5 text-[10px] ${statusFilter === s ? 'opacity-70' : 'text-slate-400'}`}>({count})</span>}
              </button>
            );
          })}
        </div>
      </div>

      {/* ─── Bulk Actions (QA only) ─── */}
      {isApprover && selected.size > 0 && (
        <div className="flex items-center gap-3 px-5 py-3 rounded-xl border" style={{ backgroundColor: 'var(--theme-primary-light)', borderColor: 'var(--theme-primary)' }}>
          <div className="w-8 h-8 rounded-full flex items-center justify-center" style={{ backgroundColor: 'var(--theme-primary-light)' }}>
            <span className="text-sm font-bold" style={{ color: 'var(--theme-primary-dark)' }}>{selected.size}</span>
          </div>
          <span className="text-sm font-medium" style={{ color: 'var(--theme-primary-dark)' }}>entries selected</span>
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => handleApprove([...selected])} disabled={processing}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 text-white text-xs font-semibold rounded-lg hover:bg-emerald-700 disabled:opacity-50 shadow-sm transition-all">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
              Approve
            </button>
            <button onClick={() => handleReject([...selected])} disabled={processing}
              className="inline-flex items-center gap-1.5 px-4 py-2 bg-red-600 text-white text-xs font-semibold rounded-lg hover:bg-red-700 disabled:opacity-50 shadow-sm transition-all">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
              Reject
            </button>
            <button onClick={() => setSelected(new Set())} className="px-3 py-2 text-xs font-medium text-slate-500 hover:text-slate-700 rounded-lg hover:bg-white/50 transition-all">Clear</button>
          </div>
        </div>
      )}

      {/* ─── Table ─── */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
            <p className="text-sm text-slate-400">Loading schedules...</p>
          </div>
        ) : entries.length === 0 ? (
          <div className="py-20 text-center">
            <svg className="w-12 h-12 text-slate-300 mx-auto mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
            <p className="text-slate-500 font-medium">No schedule entries found</p>
            <p className="text-xs text-slate-400 mt-1">Upload a CSV to create schedule entries for this period</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200">
                  {isApprover && (
                    <th className="w-10 px-3 py-3.5">
                      <input type="checkbox" checked={allPendingSelected} onChange={toggleSelectAll}
                        className="w-3.5 h-3.5 rounded border-slate-300 cursor-pointer" style={{ accentColor: 'var(--theme-primary)' }} />
                    </th>
                  )}
                  <th className="w-14 text-center px-2 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">S.No</th>
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">AHU</th>
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Scheduled Date</th>
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Tolerance</th>
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Window</th>
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Status</th>
                  <th className="text-left px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Approved By</th>
                  <th className="text-right px-5 py-3.5 text-[11px] font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {groupedEntries.map(group => {
                  const isExpanded = expandedAhus.has(group.ahuId);
                  return (
                  <React.Fragment key={group.ahuId}>
                    {group.entries.map((entry, entryIdx) => {
                      const sc = STATUS_CFG[entry.approvalStatus] ?? STATUS_CFG.PENDING;
                      const isEditing = editingId === entry.id;
                      const hasPendingEdit = !!entry.pendingPlannedDate;
                      const globalIdx = paginatedEntries.indexOf(entry);
                      const serialNo = (page - 1) * perPage + globalIdx + 1;

                      return (
                        <tr key={entry.id} className={`transition-colors hover:bg-slate-50/50 ${entry.approvalStatus === 'PENDING' ? 'bg-amber-50/15' : entry.approvalStatus === 'REJECTED' ? 'bg-red-50/15' : ''}`}>
                          {isApprover && (
                            <td className="w-10 px-3 py-3">
                              {entry.approvalStatus === 'PENDING' && (
                                <input type="checkbox" checked={selected.has(entry.id)} onChange={() => toggleSelect(entry.id)}
                                  className="w-3.5 h-3.5 rounded border-slate-300 cursor-pointer" style={{ accentColor: 'var(--theme-primary)' }} />
                              )}
                            </td>
                          )}
                          <td className="w-14 text-center px-2 py-3 text-sm text-slate-400 font-medium">{serialNo}</td>
                          <td className="px-5 py-3">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-semibold text-slate-800">{group.ahuName}</span>
                              {ahuFiltersEnabled && group.filterNames.length > 0 && (
                                <button onClick={e => { e.stopPropagation(); toggleAhuExpand(group.ahuId); }}
                                  className="text-[10px] px-1.5 py-0.5 rounded border transition-colors font-medium" style={{ color: 'var(--theme-primary)', backgroundColor: 'var(--theme-primary-light)', borderColor: 'var(--theme-primary)' }}>
                                  {group.filterNames.length} filters {isExpanded ? '▾' : '▸'}
                                </button>
                              )}
                              {/* Audit 2026-05-09 fix: surface DELETE schedule button on the
                                  FIRST entry of each AHU group so operators can retire
                                  schedules without DB intervention. */}
                              {canDeleteSchedule && entryIdx === 0 && entry.scheduleId && (
                                <button
                                  onClick={e => {
                                    e.stopPropagation();
                                    setDeleteScheduleConfirm({ scheduleId: entry.scheduleId, ahuName: group.ahuName });
                                  }}
                                  aria-label={`Delete schedule for ${group.ahuName}`}
                                  title="Delete this AHU's schedule"
                                  className="ml-auto text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors w-6 h-6 rounded flex items-center justify-center"
                                >
                                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a2 2 0 012-2h2a2 2 0 012 2v3" />
                                  </svg>
                                </button>
                              )}
                            </div>
                            {/* Inline filter list when expanded — only show on first entry of the group */}
                            {ahuFiltersEnabled && isExpanded && entryIdx === 0 && group.filterNames.length > 0 && (
                              <div className="mt-2 flex flex-wrap gap-1.5">
                                {group.filterNames.map((fn, fi) => (
                                  <span key={fi} className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-lg border" style={{ color: 'var(--theme-primary-dark)', backgroundColor: 'var(--theme-primary-light)', borderColor: 'var(--theme-primary)' }}>
                                    <span className="w-4.5 h-4.5 text-[10px] font-bold text-white rounded-full flex items-center justify-center leading-none" style={{ width: 18, height: 18, backgroundColor: 'var(--theme-primary)' }}>{fi + 1}</span>
                                    {fn}
                                  </span>
                                ))}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            {isEditing ? (
                              <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)}
                                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50 focus:bg-white focus:ring-2 w-40 transition-all"
                                style={{ '--tw-ring-color': 'var(--theme-focus-ring)' } as any} />
                            ) : (
                              <div>
                                <span className="text-sm font-medium text-slate-700 tabular-nums">{formatDate(entry.plannedDate)}</span>
                                {hasPendingEdit && (
                                  <div className="text-[10px] text-amber-600 font-medium mt-0.5 flex items-center gap-1">
                                    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                                    Pending: {formatDate(entry.pendingPlannedDate!)}
                                  </div>
                                )}
                              </div>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            {isEditing ? (
                              <input type="number" value={editTolerance} onChange={e => setEditTolerance(e.target.value)}
                                placeholder={String(entry.toleranceDays)} min={0} max={365}
                                className="border border-slate-200 rounded-lg px-3 py-1.5 text-sm bg-slate-50 focus:bg-white focus:ring-2 w-20 transition-all"
                                style={{ '--tw-ring-color': 'var(--theme-focus-ring)' } as any} />
                            ) : (
                              <span className="text-sm text-slate-500 font-medium">{entry.toleranceDays} days</span>
                            )}
                          </td>
                          <td className="px-5 py-3 text-sm text-slate-400 tabular-nums whitespace-nowrap">
                            {formatDate(entry.windowStart)} — {formatDate(entry.windowEnd)}
                          </td>
                          <td className="px-5 py-3">
                            <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-bold ${sc.bg} ${sc.text} ${sc.border}`}>
                              <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                              {sc.label}
                            </span>
                          </td>
                          <td className="px-5 py-3">
                            {entry.approvedByName ? (
                              <div className="flex items-center gap-1.5">
                                <div className="w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center">
                                  <svg className="w-3 h-3 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                </div>
                                <span className="text-xs font-medium text-emerald-700">{entry.approvedByName}</span>
                              </div>
                            ) : entry.submittedByName ? (
                              <span className="text-xs text-slate-400">by {entry.submittedByName}</span>
                            ) : (
                              <span className="text-xs text-slate-300">--</span>
                            )}
                          </td>
                          <td className="px-5 py-3">
                            <div className="flex items-center justify-end gap-1.5">
                              {isEditing ? (
                                <>
                                  <button onClick={() => entry.approvalStatus === 'REJECTED' ? handleResubmit(entry.id) : entry.approvalStatus === 'PENDING_REVIEW' ? handleReviewEdit(entry.id) : handleEdit(entry.id)}
                                    disabled={processing || !editDate}
                                    className="px-3.5 py-1.5 text-white text-[11px] font-semibold rounded-lg disabled:opacity-50 transition-colors shadow-sm"
                                    style={{ backgroundColor: 'var(--theme-primary)' }}>
                                    Save
                                  </button>
                                  <button onClick={() => setEditingId(null)} className="px-3.5 py-1.5 bg-slate-100 text-slate-600 text-[11px] font-semibold rounded-lg hover:bg-slate-200 transition-colors">
                                    Cancel
                                  </button>
                                </>
                              ) : (
                                <>
                                  {canReview && (entry.approvalStatus === 'PENDING_REVIEW' || (workflowOn && entry.approvalStatus === 'PENDING')) && (
                                    <>
                                      <button onClick={() => handleReviewApprove([entry.id])} disabled={processing}
                                        className="px-3 py-1.5 bg-sky-500 text-white text-[11px] font-semibold rounded-lg hover:bg-sky-600 disabled:opacity-50 transition-colors shadow-sm">
                                        Review ✓
                                      </button>
                                      <button onClick={() => handleReject([entry.id], 'review')} disabled={processing}
                                        className="px-3 py-1.5 bg-red-500 text-white text-[11px] font-semibold rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors shadow-sm">
                                        Reject
                                      </button>
                                      <button onClick={() => { setEditingId(entry.id); setEditDate(entry.plannedDate.slice(0, 10)); setEditTolerance(String(entry.toleranceDays)); }}
                                        className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 text-[11px] font-semibold rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all">
                                        Modify
                                      </button>
                                    </>
                                  )}
                                  {isApprover && (entry.approvalStatus === 'PENDING_APPROVAL' || (!workflowOn && entry.approvalStatus === 'PENDING')) && (
                                    <>
                                      <button onClick={() => handleApprove([entry.id])} disabled={processing}
                                        className="px-3 py-1.5 bg-emerald-500 text-white text-[11px] font-semibold rounded-lg hover:bg-emerald-600 disabled:opacity-50 transition-colors shadow-sm">
                                        Approve
                                      </button>
                                      <button onClick={() => handleReject([entry.id], 'approval')} disabled={processing}
                                        className="px-3 py-1.5 bg-red-500 text-white text-[11px] font-semibold rounded-lg hover:bg-red-600 disabled:opacity-50 transition-colors shadow-sm">
                                        Reject
                                      </button>
                                    </>
                                  )}
                                  {canEditEntry && entry.approvalStatus === 'APPROVED' && !hasPendingEdit && (
                                    <button onClick={() => { setEditingId(entry.id); setEditDate(entry.plannedDate.slice(0, 10)); setEditTolerance(String(entry.toleranceDays)); }}
                                      className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 text-[11px] font-semibold rounded-lg hover:bg-slate-50 hover:border-slate-300 transition-all">
                                      Edit
                                    </button>
                                  )}
                                  {canResubmit && entry.approvalStatus === 'REJECTED' && (
                                    <button onClick={() => { setEditingId(entry.id); setEditDate(entry.plannedDate.slice(0, 10)); setEditTolerance(String(entry.toleranceDays)); }}
                                      className="px-3 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 text-[11px] font-semibold rounded-lg hover:bg-amber-100 transition-all">
                                      Resubmit
                                    </button>
                                  )}
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {/* ─── Pagination Footer ─── */}
        {totalEntries > 0 && (
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={totalEntries}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
            className="border-t border-slate-100"
          />
        )}
      </div>

      {/* ─── Reject Dialog ─── */}
      {rejectDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-red-500 to-rose-500" />
            <div className="p-6">
              <h3 className="text-lg font-bold text-slate-800 mb-1">Reject {rejectDialog.length} Entry(s)</h3>
              <p className="text-xs text-slate-400 mb-4">Provide a reason for rejection. The uploader will see this.</p>
              <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Remarks <span className="text-red-500">*</span></label>
              <textarea value={rejectRemarks} onChange={e => setRejectRemarks(e.target.value)}
                placeholder="Why are these entries being rejected? (required)"
                rows={3} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:border-red-400 focus:ring-2 focus:ring-red-100 outline-none" />
              <div className="flex gap-3 mt-4">
                <button onClick={() => setRejectDialog(null)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium">Cancel</button>
                <button onClick={submitReject} disabled={processing || !rejectRemarks.trim()}
                  className="flex-1 py-2.5 bg-red-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50">
                  {processing ? 'Rejecting...' : 'Reject'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Upload Dialog ─── */}
      {uploadOpen && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-2xl shadow-2xl overflow-hidden">
            <div className="h-1.5" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
            <div className="p-6">
              <div className="flex items-center justify-between mb-5">
                <div>
                  <h3 className="text-lg font-bold text-slate-800">Upload PM Schedule</h3>
                  <p className="text-xs text-slate-400 mt-0.5">CSV or XLSX • max 5 MB • entries go to Pending for QA approval</p>
                </div>
                <button onClick={() => { setUploadOpen(false); setResult(null); setUploadError(''); }}
                  className="w-9 h-9 rounded-xl bg-slate-100 text-slate-500 hover:bg-slate-200 flex items-center justify-center" aria-label="Close">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>
              {!result && (
                <div onDragOver={e => { e.preventDefault(); setDragActive(true); }} onDragLeave={() => setDragActive(false)} onDrop={onDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-2xl p-10 text-center cursor-pointer transition-all ${dragActive ? 'border-slate-300 bg-slate-50' : 'border-slate-300 bg-slate-50'}`}
                  style={dragActive ? { borderColor: 'var(--theme-primary)', backgroundColor: 'var(--theme-primary-light)' } : undefined}>
                  {uploading ? (
                    <><div className="w-6 h-6 border-2 border-t-transparent rounded-full animate-spin mx-auto mb-2" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} /><p className="text-sm font-semibold text-slate-700">Uploading...</p></>
                  ) : (
                    <><p className="text-sm font-semibold text-slate-700">{dragActive ? 'Drop the file here' : 'Drag and drop or click to choose'}</p><p className="text-xs text-slate-400 mt-1">Accepts .csv, .xls, .xlsx</p></>
                  )}
                  <input ref={fileInputRef} type="file" accept=".csv,.xls,.xlsx" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                </div>
              )}
              {uploadError && <div className="mt-4 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl p-3 text-sm">{uploadError}</div>}
              {result && (
                <div className="space-y-4">
                  <UploadValidationResult
                    importedCount={result.imported}
                    importedLabel="Imported (Pending QA)"
                    errors={result.details.skipped.map(s => ({ row: s.row, reason: s.reason }))}
                  />
                  <div className="flex gap-3 pt-2">
                    <button onClick={() => { setResult(null); setUploadError(''); }} className="flex-1 py-2.5 bg-white border border-slate-200 text-slate-700 rounded-xl text-sm font-semibold hover:bg-slate-50">Upload Another</button>
                    <button onClick={() => { setUploadOpen(false); setResult(null); setUploadError(''); }} className="flex-1 py-2.5 rounded-xl text-sm font-semibold shadow-lg" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))', color: '#fff' }}>Done</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── Past-Date Warning ─── */}
      {pastDateWarning && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-amber-500 to-orange-500" />
            <div className="p-6">
              <h3 className="text-lg font-bold text-slate-800 mb-1">Past Dates Detected</h3>
              <p className="text-xs text-slate-400 mb-4">These AHUs have dates before today and will appear as overdue.</p>
              <div className="space-y-1.5 max-h-60 overflow-y-auto mb-4">
                {pastDateWarning.map((e, i) => (
                  <div key={i} className="flex items-center justify-between px-3 py-2 bg-amber-50 border border-amber-100 rounded-xl text-sm">
                    <span className="font-semibold text-slate-700">{e.ahuName}</span>
                    <span className="text-amber-700 font-medium tabular-nums">{e.scheduledDate}</span>
                  </div>
                ))}
              </div>
              <div className="flex gap-3">
                <button onClick={() => { setPastDateWarning(null); setPendingFile(null); }} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium">Cancel</button>
                <button onClick={() => { const f = pendingFile; setPastDateWarning(null); setPendingFile(null); if (f) uploadFile(f); }}
                  className="flex-1 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl text-sm font-semibold shadow-lg shadow-amber-500/25">Proceed Anyway</button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setDeletingSchedule(false); setUploading(false); setProcessing(false); setCreatingSchedule(false); }}
        actionLabel="PM Schedule Action" />

      {/* Audit 2026-05-09 fix: single-PM-schedule create dialog */}
      {createDialog && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             onClick={() => !creatingSchedule && setCreateDialog(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
               onClick={e => e.stopPropagation()}>
            <div className="h-1.5" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
            <div className="px-6 py-5 space-y-4">
              <h2 className="text-base font-bold text-slate-800">New PM Schedule</h2>
              <p className="text-sm text-slate-500 -mt-2">
                Schedules one PM for the selected AHU on the chosen date. An AHU can
                have one PM schedule per year.
              </p>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">AHU</label>
                <select value={createForm.ahuId}
                        onChange={e => setCreateForm(f => ({ ...f, ahuId: e.target.value }))}
                        className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100 bg-white">
                  <option value="">Select an AHU…</option>
                  {ahuInstances.map((a: any) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
                {ahuInstances.length === 0 && (
                  <p className="text-xs text-amber-700 mt-1">No AHU instances found. Create an AHU under a Block first.</p>
                )}
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Date</label>
                <input type="date"
                       value={createForm.plannedDate}
                       onChange={e => setCreateForm(f => ({ ...f, plannedDate: e.target.value }))}
                       className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100" />
                <p className="text-xs text-slate-400 mt-1">Select the year, month and day for this PM.</p>
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1">Tolerance days</label>
                <input type="number" min={0} max={365}
                       value={createForm.toleranceDays}
                       onChange={e => setCreateForm(f => ({ ...f, toleranceDays: Number(e.target.value) }))}
                       className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100" />
                <p className="text-xs text-slate-400 mt-1">Window: planned date ± tolerance days.</p>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
              <button type="button" onClick={() => setCreateDialog(false)} disabled={creatingSchedule}
                      className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={submitCreateSchedule}
                      disabled={creatingSchedule || !createForm.ahuId || !createForm.plannedDate}
                      className="flex-1 py-2.5 rounded-xl text-sm font-semibold shadow-lg disabled:opacity-50"
                      style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))', color: '#fff' }}>
                {creatingSchedule ? 'Creating…' : 'Create schedule'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Overwrite confirmation — the AHU already has a schedule for the year. */}
      {overwriteConfirm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             onClick={() => !creatingSchedule && setOverwriteConfirm(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-500" />
            {overwriteConfirm.approved ? (
              <>
                <div className="px-6 py-5 space-y-3">
                  <h2 className="text-base font-bold text-slate-800">PM schedule already exists</h2>
                  <p className="text-sm text-slate-600">
                    <span className="font-semibold">{overwriteConfirm.ahuName}</span> has an approved PM
                    schedule for {overwriteConfirm.year} (planned {overwriteConfirm.existingDate}).
                    Overwrite it with <span className="font-semibold">{createForm.plannedDate}</span>?
                  </p>
                  <p className="text-xs text-slate-400">
                    The change goes to review → approval (a QNN is raised). The current date stays
                    active and keeps generating PM tasks until the change is approved.
                  </p>
                </div>
                <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
                  <button type="button" onClick={() => setOverwriteConfirm(null)} disabled={creatingSchedule}
                          className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50">
                    Keep existing
                  </button>
                  <button type="button"
                          onClick={() => doOverwrite(overwriteConfirm.entryId)}
                          disabled={creatingSchedule}
                          className="flex-1 py-2.5 rounded-xl text-sm font-semibold shadow-lg disabled:opacity-50 bg-gradient-to-r from-amber-500 to-orange-500 text-white hover:from-amber-400 hover:to-orange-400">
                    {creatingSchedule ? 'Submitting…' : 'Overwrite'}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="px-6 py-5 space-y-3">
                  <h2 className="text-base font-bold text-slate-800">PM schedule awaiting review</h2>
                  <p className="text-sm text-slate-600">
                    <span className="font-semibold">{overwriteConfirm.ahuName}</span> already has a PM
                    schedule for {overwriteConfirm.year} (planned {overwriteConfirm.existingDate}) that is
                    still awaiting review/approval. Approve or reject it first, then you can change the date.
                  </p>
                </div>
                <div className="px-6 py-4 border-t border-slate-100 flex">
                  <button type="button" onClick={() => setOverwriteConfirm(null)}
                          className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors">
                    Close
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {deleteScheduleConfirm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             onClick={() => !deletingSchedule && setDeleteScheduleConfirm(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
               onClick={e => e.stopPropagation()}>
            <div className="h-1.5 bg-gradient-to-r from-red-400 to-rose-500" />
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center text-red-600 shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-800">Delete PM schedule</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    Delete the PM schedule for "{deleteScheduleConfirm.ahuName}"? All future planned entries for this AHU will be removed. If a PM execution is currently in progress, the server will reject the delete.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
              <button type="button" onClick={() => setDeleteScheduleConfirm(null)} disabled={deletingSchedule}
                      className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={submitDeleteSchedule} disabled={deletingSchedule}
                      className="flex-1 py-2.5 bg-gradient-to-r from-red-500 to-rose-500 text-white rounded-xl text-sm font-semibold hover:from-red-400 hover:to-rose-400 shadow-lg shadow-red-500/25 disabled:opacity-50">
                {deletingSchedule ? 'Deleting...' : 'Delete schedule'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
