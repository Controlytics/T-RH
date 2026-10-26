import { Fragment, useState } from 'react';
import useSWR from 'swr';
import { PageHero } from '@/components/ui/page-hero';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import {
  decideReview, downloadApproved, approversText,
  type ReviewSummary, type ReviewList,
} from '@/lib/report-review';
import { DecisionDialog } from './decision-dialog';
import { ReportSnapshotView } from './report-snapshot-view';
import { normaliseSnapshot } from '@/lib/pdf-report';
import type { ReviewFull } from '@/lib/report-review';

/**
 * Reports (2026-09-07). Operator: *"once review completed and approved then
 * user and approved user can get that approved data in side bar new option
 * there user can download reports"*.
 *
 * Three lists, each the server's own answer to "what may I see" (scoped
 * there, never here — by party AND by instrument scope since 2026-10-01): the
 * requests waiting for MY decision, the requests raised by me OR ANYONE IN MY
 * ROLE, and the approved reports I may see. A row's actions follow its state
 * and my part in it: only an approver (a configured role or user) may decide a
 * PENDING one — Approve with `reports.approve`, Reject with `reports.reject`,
 * two separate permissions since 2026-10-26; an APPROVED one
 * downloads with both signatures.
 *
 * **No "View draft" (removed 2026-10-01, operator: "remove view draft and how
 * you are showing after approval that below the request show like that
 * only").** A PENDING row opens its frozen snapshot beneath it as tables, the
 * way an approved row does — the approver reads the data there and signs.
 * Design: docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 */

const TABS: { id: ReviewList; label: string }[] = [
  { id: 'queue', label: 'For my approval' },
  // Raised by me or anyone in my role (2026-10-01): "if one operator user send
  // request … then all operator user can view and download the report".
  { id: 'mine', label: 'Requests' },
  { id: 'approved', label: 'Approved' },
];

const STATUS_TONE: Record<ReviewSummary['status'], StatusTone> = { PENDING: 'warn', APPROVED: 'ok', REJECTED: 'danger' };
const STATUS_WORD: Record<ReviewSummary['status'], string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' };


export function ReportsPage() {
  const { toast } = useToast();
  const { formatDateTime } = useDatetimeFormat();
  const { defaultLimit } = usePaginationDefaults();
  const [list, setList] = useState<ReviewList>('queue');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultLimit);
  const [pending, setPending] = useState<{ review: ReviewSummary; decision: 'approve' | 'reject' } | null>(null);
  /**
   * The row that is open, showing its report data beneath it as tables
   * (operator, 2026-09-25: "once approved then if user click on that row, that
   * report data should be shown in below that row in table format"; since
   * 2026-10-01 a PENDING row opens the same way, replacing View draft). The
   * data is the frozen snapshot from `GET /api/report-reviews/:id` — the same
   * record the signed download replays — fetched only when a row is opened.
   * One row at a time; clicking it again closes it. A REJECTED row does not
   * open: it is closed, and nobody acts on its data.
   */
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const { data: expanded, error: expandedError } = useSWR<ReviewFull>(expandedId ? `/api/report-reviews/${expandedId}` : null);
  const opens = (r: ReviewSummary) => r.status !== 'REJECTED';
  const toggleExpanded = (r: ReviewSummary) => {
    if (!opens(r)) return;
    setExpandedId((cur) => (cur === r.id ? null : r.id));
  };
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const qs = new URLSearchParams({ list, page: String(page), pageSize: String(pageSize) });
  const { data, error, isLoading, mutate } = useSWR<{ data: ReviewSummary[]; total: number }>(`/api/report-reviews?${qs}`);

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  // Whether to SHOW Approve/Reject is the SERVER's per-row answer (audit
  // 2026-10-12 #9): status, the approve permission, separation of duties
  // (SUPER_ADMIN may decide their own, operator 2026-09-08), approver AND
  // instrument scope — `canDecide` on each list row. This page used to
  // re-derive it and omitted the scope. The decision route's 403 / 404 is
  // still the control. Approve and Reject are SEPARATE permissions since
  // 2026-10-26, so each button follows its own flag.
  const mayApprove = (r: ReviewSummary) => r.canApprove === true;
  const mayReject = (r: ReviewSummary) => r.canReject === true;

  const switchList = (next: ReviewList) => { setList(next); setPage(1); };

  const decide = async (remarks: string, password: string) => {
    if (!pending) return;
    setSubmitting(true);
    setDialogError('');
    try {
      await decideReview(pending.review.id, pending.decision, remarks, password);
      toast.success(pending.decision === 'approve' ? 'Report approved' : 'Report rejected', `"${pending.review.title}" — ${pending.review.requestedByName} has been notified.`);
      setPending(null);
      await mutate();
    } catch (e: any) {
      setDialogError(e?.message ?? 'The decision could not be recorded. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const download = async (r: ReviewSummary) => {
    try { await downloadApproved(r.id, formatDateTime); }
    catch (e: any) { toast.error('Could not download the report', e?.message ?? 'Please try again.'); }
  };

  const periodText = (r: ReviewSummary) => {
    const p = r.requestMeta?.period;
    if (!p) return '-';
    return p.label && p.label !== 'Custom' ? p.label : `${formatDateTime(p.from)} – ${formatDateTime(p.to)}`;
  };

  return (
    <div className="space-y-5">
      <PageHero
        title="Reports"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Reports' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        }
      />

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
        <Tabs tabs={TABS} active={list} onChange={switchList} idPrefix="reports" aria-label="Report lists" />

        {error ? (
          <p className="px-5 py-6 text-sm text-red-700">The reports could not be loaded. Try again.</p>
        ) : !isLoading && rows.length === 0 ? (
          <p className="px-5 py-6 text-sm text-slate-500">No requests here.</p>
        ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Report</TableHead>
                  <TableHead scope="col">Period</TableHead>
                  <TableHead scope="col">Requested</TableHead>
                  <TableHead scope="col">Send to</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  <TableHead scope="col">Decided</TableHead>
                  <TableHead scope="col" className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <Fragment key={r.id}>
                  <TableRow
                    data-review-id={r.id}
                    data-expanded={expandedId === r.id || undefined}
                    className={opens(r) ? 'cursor-pointer' : undefined}
                    aria-expanded={opens(r) ? expandedId === r.id : undefined}
                    onClick={() => toggleExpanded(r)}
                  >
                    <TableCell className="align-top">
                      <span className="block font-semibold text-slate-800">{r.title}</span>
                      <span className="block text-xs text-slate-500">
                        {r.reportType}
                        {r.requestMeta?.instrumentCodes?.length ? ` · ${r.requestMeta.instrumentCodes.join(', ')}` : ''}
                        {typeof r.requestMeta?.recordCount === 'number' ? ` · ${r.requestMeta.recordCount.toLocaleString()} rows` : ''}
                      </span>
                    </TableCell>
                    <TableCell className="align-top">{periodText(r)}</TableCell>
                    <TableCell className="align-top">
                      <span className="block">{r.requestedByName}</span>
                      <span className="block text-xs text-slate-500">{formatDateTime(r.requestedAt)}</span>
                    </TableCell>
                    <TableCell className="align-top">{approversText(r)}</TableCell>
                    <TableCell className="align-top"><StatusBadge tone={STATUS_TONE[r.status]} label={STATUS_WORD[r.status]} /></TableCell>
                    <TableCell className="align-top">
                      {r.decidedByName ? (
                        <>
                          <span className="block">{r.decidedByName}</span>
                          <span className="block text-xs text-slate-500">{r.decidedAt ? formatDateTime(r.decidedAt) : ''}</span>
                        </>
                      ) : '-'}
                    </TableCell>
                    {/* The buttons are their own acts: a click on one must not also
                        open or close the row under it. */}
                    <TableCell className="whitespace-nowrap align-top text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex justify-end gap-1.5">
                        {mayApprove(r) && (
                          <Button size="sm" onClick={() => { setDialogError(''); setPending({ review: r, decision: 'approve' }); }}>Approve</Button>
                        )}
                        {mayReject(r) && (
                          <Button size="sm" variant="secondary" onClick={() => { setDialogError(''); setPending({ review: r, decision: 'reject' }); }}>Reject</Button>
                        )}
                        {r.status === 'APPROVED' && (
                          <Button size="sm" onClick={() => download(r)}>Download</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  {expandedId === r.id && (
                    <TableRow data-review-detail={r.id}>
                      <TableCell colSpan={7} className="bg-[var(--surface-tint-1)] px-5 py-4">
                        {expandedError ? (
                          <p className="text-sm font-medium text-red-700">The report could not be loaded. Try again.</p>
                        ) : !expanded ? (
                          <p className="text-sm text-slate-500">Loading the report…</p>
                        ) : (
                          <ReportSnapshotView snapshot={normaliseSnapshot(expanded.dataSnapshot)} />
                        )}
                      </TableCell>
                    </TableRow>
                  )}
                  </Fragment>
                ))}
              </TableBody>
            </Table>
        )}

        {total > 0 && !error && (
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={setPage}
            onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          />
        )}
      </div>

      <DecisionDialog
        review={pending?.review ?? null}
        decision={pending?.decision ?? 'approve'}
        open={pending !== null}
        submitting={submitting}
        error={dialogError}
        onSubmit={decide}
        onClose={() => setPending(null)}
      />
    </div>
  );
}
