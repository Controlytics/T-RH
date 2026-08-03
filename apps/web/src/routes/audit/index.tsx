import { useState, useMemo, useEffect } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import { useRoleColors } from '@/hooks/use-role-colors';
import { apiClient, api } from '@/lib/api-client';
import { resolveBulkTargets } from '@/lib/resolve-bulk-targets';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { ReauthDialog } from '@/components/reauth-dialog';
import { getDefaultTemplates } from '@digilog/shared';
import { ReportPageWrapper } from '@/components/report-page-wrapper';
import { ACTION_COLORS, getAuditStatus, getAuditSummary, friendlyTargetType, isRedacted, redactionNote } from './audit-helpers';
import { AuditFilters } from './components/audit-filters';
import { AuditTable } from './components/audit-table';
import { AuditDetailModal } from './components/audit-detail-modal';
import { Pagination } from '@/components/ui/pagination';
import { AuditDeleteDialog } from './components/audit-delete-dialog';
import { createReport } from '../../lib/pdf-report';
import { exportToExcel } from '@/lib/excel-export';
import { logReportExport } from '@/lib/report-export-log';
import { useExportLimit } from '@/hooks/use-export-limit';
import { ExportMenu } from '@/components/ExportMenu';
import { SendForReviewButton } from '@/components/SendForReviewButton';
import { useReportLabels } from '../../hooks/use-report-labels';

const AUDIT_COLS = ['timestamp', 'action', 'user', 'role', 'targetType', 'description', 'ipAddress'];

export function AuditTrailPage() {
  const { user } = useAuth();
  const can = useCan();
  const reauth = useReauth();
  const { toast } = useToast();
  const exportLimit = useExportLimit();
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const { options: paginationOptions, defaultLimit } = usePaginationDefaults();
  const { labelsFor } = useReportLabels();
  const auditL = labelsFor('audit-trail');
  const auditHead = AUDIT_COLS.map((k) => auditL.columns[k]);
  // audit.export gate: ['AUDIT_EXPORT'] → SUPER_ADMIN || AUDIT_EXPORT (same as prior check).
  const canExport = can('audit.export');
  // Destructive affordances. Redact (audit.redact) preserves the hash chain and is
  // SUPER_ADMIN-only (gate []). Hard-delete (audit.delete) physically removes the row
  // and BREAKS the chain — a grantable picker toggle (gate ['AUDIT_DELETE']). Either
  // one unlocks the SELECTION column + the destructive row buttons. Reading a record
  // (the Details column + detail dialog) is NOT gated on these — the route already
  // requires AUDIT_READ, and gating reads on destroy rights locked inspectors out.
  const canRedact = can('audit.redact');
  const canHardDelete = can('audit.delete');
  const canDestroy = canRedact || canHardDelete;
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(defaultLimit);

  // Fetch configurable audit text templates (cached for 5 min)
  const { data: templatesData } = useSWR<Record<string, string>>('/api/config/audit-templates/current', {
    revalidateOnMount: true, dedupingInterval: 5000,
    revalidateOnFocus: false,
  });
  const templates = useMemo(() => templatesData ?? getDefaultTemplates(), [templatesData]);

  // Fetch roles for dynamic colors
  const { roleColors: ROLE_COLORS } = useRoleColors();
  const [search, setSearch] = useState('');
  const [fromDateTime, setFromDateTime] = useState('');
  const [toDateTime, setToDateTime] = useState('');
  const [selectedRecord, setSelectedRecord] = useState<any>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showHardDeleteConfirm, setShowHardDeleteConfirm] = useState(false);
  const [hardDeleting, setHardDeleting] = useState(false);
  const [sortBy, setSortBy] = useState<'timestamp' | 'action' | 'userId' | 'userRole'>('timestamp');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');

  const toggleSort = (field: typeof sortBy) => {
    if (sortBy === field) {
      setSortOrder(prev => prev === 'asc' ? 'desc' : 'asc');
    } else {
      setSortBy(field);
      setSortOrder(field === 'timestamp' ? 'desc' : 'asc');
    }
    setPage(1);
  };

  const params = new URLSearchParams({ page: String(page), limit: String(perPage), sortBy, sortOrder });
  if (search) params.set('search', search);

  // Use combined datetime values for API — convert local time to UTC ISO string
  if (fromDateTime) {
    params.set('startDate', new Date(fromDateTime).toISOString());
  }
  if (toDateTime) {
    params.set('endDate', new Date(toDateTime).toISOString());
  }

  const { data, isLoading, mutate } = useSWR(`/api/audit?${params}`);

  // Clear selection whenever the rendered rows change. sortBy/sortOrder/perPage
  // are deps too: they are all in the query above, so each one swaps the rows on
  // screen. They were missing, and `toggleSort` only calls setPage(1) — a no-op
  // when already on page 1 — so a re-sort left the selection pointing at rows the
  // operator could no longer see, aimed at an irreversible, hash-chain-breaking
  // bulk delete.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, search, fromDateTime, toDateTime, sortBy, sortOrder, perPage]);

  // Second, independent guard: resolve every bulk action against the rows
  // actually rendered. Clearing on change fixes the known paths; intersecting
  // makes "we only ever destroy what you can see" true by construction, and the
  // toolbar count + the dialogs read from this same value, so the number the
  // operator confirms is exactly the number that dies.
  const visibleRecords: any[] = data?.data ?? [];
  const selectedRecords = useMemo(
    () => resolveBulkTargets(selectedIds, visibleRecords),
    [selectedIds, visibleRecords],
  );
  const selectedTargetIds = useMemo(() => selectedRecords.map((r) => r.id), [selectedRecords]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!data?.data) return;
    const allIds = data.data.map((r: any) => r.id as string);
    const allSelected = allIds.every((id: string) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  };

  const isAllSelected = data?.data?.length > 0 && data.data.every((r: any) => selectedIds.has(r.id));
  // Counted from the resolved targets, not the raw Set — see selectedRecords above.
  const selectedCount = selectedRecords.length;
  const isSomeSelected = selectedCount > 0;

  // Delta-audit 2026-05-20 §C1 / May 16 §1.2: audit DELETE replaced with REDACT.
  // REDACT preserves checksum + chain link, NULLs the payload, stamps redactedAt/By.
  // Per 21 CFR §11.10(e) the chain MUST remain intact — physical deletion broke it.
  // Operator must supply a reason (>= 5 chars).
  const redactSingleAudit = (id: string) => {
    const reason = window.prompt('Reason for redacting this audit record (min 5 characters):');
    if (!reason || reason.trim().length < 5) return;
    reauth.execute(
      'REDACT_AUDIT_RECORD',
      async (password?: string) => {
        const body = { reason: reason.trim() };
        if (password) await api.postWithReauth(`/api/audit/${id}/redact`, body, password);
        else await apiClient.post(`/api/audit/${id}/redact`, body);
      },
      {
        onSuccess: () => {
          setSelectedIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          mutate();
        },
        // A failed §11 redaction must never pass silently — the operator has to
        // know the payload is still there. reauth.cancel() does not route here,
        // so this only ever fires on a real failure.
        onError: (err: any) => toast.error('Redaction Failed', err?.message ?? 'The audit record was not redacted.'),
      },
    );
  };

  const bulkRedactAudit = () => {
    if (selectedTargetIds.length === 0) return;
    const reason = window.prompt(`Reason for redacting ${selectedCount} audit records (min 5 characters):`);
    if (!reason || reason.trim().length < 5) return;
    setDeleting(true);
    reauth.execute(
      'BULK_REDACT_AUDIT_RECORDS',
      async (password?: string) => {
        const body = { ids: selectedTargetIds, reason: reason.trim() };
        if (password) await api.postWithReauth('/api/audit/bulk-redact', body, password);
        else await apiClient.post('/api/audit/bulk-redact', body);
      },
      {
        onSuccess: () => {
          setSelectedIds(new Set());
          setShowDeleteConfirm(false);
          mutate();
          setDeleting(false);
        },
        onError: (err: any) => {
          toast.error('Bulk Redaction Failed', err?.message ?? 'No audit records were redacted.');
          setDeleting(false);
        },
      },
    );
  };

  // PHYSICAL hard-delete (audit.delete). Unlike redact, this removes the row and
  // BREAKS the hash chain — verify-chain will report the trail invalid downstream.
  // Requires a reason (>= 5 chars) + reauth (DELETE_AUDIT_RECORD).
  const hardDeleteSingleAudit = (id: string) => {
    const reason = window.prompt('This PERMANENTLY deletes the record and breaks the tamper-evident hash chain.\nReason for deletion (min 5 characters):');
    if (!reason || reason.trim().length < 5) return;
    reauth.execute(
      'DELETE_AUDIT_RECORD',
      async (password?: string) => {
        const body = { reason: reason.trim() };
        if (password) await api.deleteWithReauth(`/api/audit/${id}`, password, body);
        else await apiClient.delete(`/api/audit/${id}`, body);
      },
      {
        onSuccess: () => {
          setSelectedIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          mutate();
        },
        onError: (err: any) => toast.error('Delete Failed', err?.message ?? 'The audit record was not deleted.'),
      },
    );
  };

  const bulkHardDeleteAudit = () => {
    if (selectedTargetIds.length === 0) return;
    const reason = window.prompt(`This PERMANENTLY deletes ${selectedCount} record(s) and breaks the tamper-evident hash chain.\nReason for deletion (min 5 characters):`);
    if (!reason || reason.trim().length < 5) return;
    setHardDeleting(true);
    reauth.execute(
      'BULK_DELETE_AUDIT_RECORDS',
      async (password?: string) => {
        const body = { ids: selectedTargetIds, reason: reason.trim() };
        if (password) await api.postWithReauth('/api/audit/bulk-delete', body, password);
        else await apiClient.post('/api/audit/bulk-delete', body);
      },
      {
        onSuccess: () => {
          setSelectedIds(new Set());
          setShowHardDeleteConfirm(false);
          mutate();
          setHardDeleting(false);
        },
        onError: (err: any) => {
          toast.error('Bulk Delete Failed', err?.message ?? 'No audit records were deleted.');
          setHardDeleting(false);
        },
      },
    );
  };

  const clearFilters = () => {
    setSearch('');
    setFromDateTime('');
    setToDateTime('');
    setPage(1);
  };

  const hasFilters = search || fromDateTime || toDateTime;
  const [downloading, setDownloading] = useState(false);

  // Format datetime for display using global config
  const formatDateTimeDisplay = (datetime: string) => {
    if (!datetime) return '';
    return formatDateTime(datetime);
  };

  const currentPeriod = (): string =>
    fromDateTime || toDateTime
      ? `${fromDateTime ? formatDateTime(fromDateTime) : 'Start'} to ${toDateTime ? formatDateTime(toDateTime) : 'Now'}`
      : 'All Time';

  // The export is what an inspector actually receives, so a redacted record must
  // announce itself here too — not only on screen. The note leads the description
  // so it survives the truncation below.
  const exportDescription = (r: any): string => {
    const summary = getAuditSummary(r, templates);
    const text = isRedacted(r) ? `${redactionNote(r)} ${summary}`.trim() : summary;
    return text.substring(0, 80);
  };

  const mapAuditRows = (records: any[]): string[][] =>
    records.map((r: any) => [
      formatDateTime(r.timestamp), r.action?.replace(/_/g, ' ') ?? '-', r.userId ?? '-',
      r.userRole ?? '-', friendlyTargetType(r), exportDescription(r), r.ipAddress ?? '-',
    ]);

  // Fetch ALL records matching the active filters (not just the visible page).
  // The list API caps each request at 200, so page through until exhausted.
  const fetchAllFilteredRecords = async (): Promise<any[]> => {
    const all: any[] = [];
    const LIMIT = 200;
    let pageN = 1;
    for (;;) {
      const qs = new URLSearchParams({ page: String(pageN), limit: String(LIMIT), sortBy, sortOrder });
      if (search) qs.set('search', search);
      if (fromDateTime) qs.set('startDate', new Date(fromDateTime).toISOString());
      if (toDateTime) qs.set('endDate', new Date(toDateTime).toISOString());
      const res = await apiClient.get<{ data?: any[]; total?: number }>(`/api/audit?${qs}`);
      const rows = res?.data ?? [];
      all.push(...rows);
      const total = res?.total ?? all.length;
      if (rows.length === 0 || all.length >= total || pageN > 500) break;
      pageN++;
    }
    return all;
  };

  // Record the export as an auditable event BEFORE the file is saved. Throws on
  // failure so the caller can block the download (fail-closed, 21 CFR §11).
  const logExport = async (format: 'PDF' | 'Excel', recordCount: number) => {
    await logReportExport({
      reportType: 'Audit Trail', format, recordCount,
      period: currentPeriod(),
      search: search || undefined,
      startDate: fromDateTime ? new Date(fromDateTime).toISOString() : undefined,
      endDate: toDateTime ? new Date(toDateTime).toISOString() : undefined,
    });
  };

  const exportPdf = async () => {
    setDownloading(true);
    try {
      const records = await fetchAllFilteredRecords();
      if (records.length === 0) { toast.error('Nothing to export', 'No audit records match the current filters.'); return; }
      if (records.length > exportLimit.maxRecords) {
        toast.error('Export too large', exportLimit.tooLargeMessage(records.length));
        return;
      }
      const report = await createReport({ reportKey: 'audit-trail',
        title: auditL.title,
        subtitle: auditL.subtitle || `Period: ${currentPeriod()}${search ? `  |  Search: "${search}"` : ''}  |  Total: ${records.length} record(s)  |  21 CFR Part 11 Compliant`,
        orientation: 'landscape',
        formatDateTime,
      });
      report.addTable({ head: auditHead, body: mapAuditRows(records), columnStyles: { 0: { cellWidth: 35 }, 5: { cellWidth: 65 } } });
      // Fail-closed: if the export can't be recorded, cancel the download.
      try {
        await logExport('PDF', records.length);
      } catch (e: any) {
        toast.error('Export blocked', `Could not record this download in the audit trail: ${e?.message ?? 'unknown error'}. Download cancelled.`);
        return;
      }
      report.save(`audit-trail-${new Date().toISOString().slice(0, 10)}.pdf`);
    } catch (e: any) {
      toast.error('Export failed', e?.message ?? 'Could not export the audit trail. Please try again.');
    } finally { setDownloading(false); }
  };

  // Snapshot for the review workflow — same build over all filtered records,
  // captured instead of saved (no export-log; nothing is downloaded here).
  const buildAuditSnapshot = async () => {
    const records = await fetchAllFilteredRecords();
    if (records.length === 0) return null;
    const report = await createReport({ reportKey: 'audit-trail',
      title: auditL.title,
      subtitle: auditL.subtitle || `Period: ${currentPeriod()}${search ? `  |  Search: "${search}"` : ''}  |  Total: ${records.length} record(s)  |  21 CFR Part 11 Compliant`,
      orientation: 'landscape',
      formatDateTime,
    });
    report.addTable({ head: auditHead, body: mapAuditRows(records), columnStyles: { 0: { cellWidth: 35 }, 5: { cellWidth: 65 } } });
    return report.getSnapshot();
  };

  const exportExcel = async () => {
    setDownloading(true);
    try {
      const records = await fetchAllFilteredRecords();
      if (records.length === 0) { toast.error('Nothing to export', 'No audit records match the current filters.'); return; }
      if (records.length > exportLimit.maxRecords) {
        toast.error('Export too large', exportLimit.tooLargeMessage(records.length));
        return;
      }
      // Fail-closed: if the export can't be recorded, cancel the download.
      try {
        await logExport('Excel', records.length);
      } catch (e: any) {
        toast.error('Export blocked', `Could not record this download in the audit trail: ${e?.message ?? 'unknown error'}. Download cancelled.`);
        return;
      }
      exportToExcel({ filename: `audit-trail-${new Date().toISOString().slice(0, 10)}`, sheetName: 'Audit Trail', head: auditHead, rows: mapAuditRows(records) });
    } catch (e: any) {
      toast.error('Export failed', e?.message ?? 'Could not export the audit trail. Please try again.');
    } finally { setDownloading(false); }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-2xl text-white shadow-lg" style={{ backgroundImage: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">{auditL.title}</h1>
            <p className="text-sm text-slate-500">21 CFR Part 11 Compliant Activity Log</p>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {data && (
            <div className="text-right">
              <p className="text-2xl font-bold text-slate-800">{data.total.toLocaleString()}</p>
              <p className="text-xs text-slate-500">Total Records</p>
            </div>
          )}
          {canExport && (data?.data?.length ?? 0) > 0 && (
            <>
              <ExportMenu surface="audit" onExportPdf={exportPdf} onExportExcel={exportExcel} busy={downloading}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors disabled:opacity-40" />
              <SendForReviewButton buildSnapshot={buildAuditSnapshot} />
            </>
          )}
        </div>
      </div>

      {/* Filters Card */}
      <AuditFilters
        search={search}
        setSearch={setSearch}
        fromDateTime={fromDateTime}
        setFromDateTime={setFromDateTime}
        toDateTime={toDateTime}
        setToDateTime={setToDateTime}
        setPage={setPage}
        formatDateTimeDisplay={formatDateTimeDisplay}
        hasFilters={hasFilters}
        clearFilters={clearFilters}
      />

      {/* Destructive Selection Toolbar. Redact (audit.redact, SA-only) preserves the
          hash chain; Delete Permanently (audit.delete) physically removes rows + breaks
          the chain. Shown when the user can do EITHER. */}
      {canDestroy && isSomeSelected && (
        <div className="bg-white rounded-2xl border-2 border-red-200 shadow-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-100">
              <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-slate-700">{selectedCount} audit record{selectedCount > 1 ? 's' : ''} selected</span>
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-500 hover:text-slate-700 underline">
              Clear Selection
            </button>
          </div>
          <div className="flex items-center gap-2">
            {canRedact && (
              <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(true)} className="gap-1.5 text-amber-700 border-amber-200 hover:bg-amber-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                Redact Selected
              </Button>
            )}
            {canHardDelete && (
              <Button variant="outline" size="sm" onClick={() => setShowHardDeleteConfirm(true)} className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Permanently
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Table Card */}
      <ReportPageWrapper
        title={auditL.title}
        totalRecords={data?.total ?? 0}
        page={page}
        totalPages={data?.totalPages ?? 1}
      >
        <AuditTable
          data={data}
          isLoading={isLoading}
          canDestroy={canDestroy}
          canRedact={canRedact}
          canHardDelete={canHardDelete}
          onHardDeleteRecord={hardDeleteSingleAudit}
          selectedIds={selectedIds}
          toggleSelect={toggleSelect}
          toggleSelectAll={toggleSelectAll}
          isAllSelected={isAllSelected}
          sortBy={sortBy}
          sortOrder={sortOrder}
          toggleSort={toggleSort}
          formatDate={formatDate}
          formatTime={formatTime}
          getAuditSummary={getAuditSummary}
          getAuditStatus={getAuditStatus}
          templates={templates}
          ACTION_COLORS={ACTION_COLORS}
          onViewRecord={setSelectedRecord}
          onDeleteRecord={redactSingleAudit}
        />
      </ReportPageWrapper>

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="bg-white rounded-xl border border-slate-200">
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={data.total}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
          />
        </div>
      )}

      {/* Detail Dialog */}
      <AuditDetailModal
        selectedRecord={selectedRecord}
        onClose={() => setSelectedRecord(null)}
        formatDateTime={formatDateTime}
        getAuditSummary={getAuditSummary}
        getAuditStatus={getAuditStatus}
        templates={templates}
        ACTION_COLORS={ACTION_COLORS}
        ROLE_COLORS={ROLE_COLORS}
      />

      {/* Bulk Redact Confirmation Dialog (chain-preserving) */}
      <AuditDeleteDialog
        open={showDeleteConfirm}
        selectedCount={selectedCount}
        deleting={deleting}
        onClose={() => setShowDeleteConfirm(false)}
        onConfirm={bulkRedactAudit}
        mode="redact"
      />

      {/* Bulk Hard-Delete Confirmation Dialog (physical — breaks the chain) */}
      <AuditDeleteDialog
        open={showHardDeleteConfirm}
        selectedCount={selectedCount}
        deleting={hardDeleting}
        onClose={() => setShowHardDeleteConfirm(false)}
        onConfirm={bulkHardDeleteAudit}
        mode="delete"
      />

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setDeleting(false); setHardDeleting(false); }}
        actionLabel="Delete Audit Record"
      />
    </div>
  );
}
