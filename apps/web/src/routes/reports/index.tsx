import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS_PARAM } from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { Tabs } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { Pagination } from '@/components/ui/pagination';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { useAuth } from '@/hooks/use-auth';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import {
  decideReview, openDraft, downloadApproved, assigneeText,
  type ReviewSummary, type ReviewList,
} from '@/lib/report-review';
import { DecisionDialog } from './decision-dialog';

/**
 * Reports (2026-09-07). Operator: *"once review completed and approved then
 * user and approved user can get that approved data in side bar new option
 * there user can download reports"*.
 *
 * Three lists, each the server's own answer to "what may I see" (party-scoped
 * there, never here): the requests waiting for MY decision, the requests I
 * raised, and the approved reports I am a party to. A row's actions follow
 * its state and my part in it: any party may look at the DRAFT while the
 * request is PENDING (not once it is approved or rejected — operator,
 * 2026-09-25); only the assignee (by user, or by holding the role) may decide
 * a PENDING one, and only with the `reports.approve` gate; an APPROVED one
 * downloads with both signatures. Design:
 * docs/superpowers/specs/2026-09-07-report-review-workflow-design.md
 */

const TABS: { id: ReviewList; label: string }[] = [
  { id: 'queue', label: 'For my approval' },
  { id: 'mine', label: 'My requests' },
  { id: 'approved', label: 'Approved' },
];

const STATUS_TONE: Record<ReviewSummary['status'], StatusTone> = { PENDING: 'warn', APPROVED: 'ok', REJECTED: 'danger' };
const STATUS_WORD: Record<ReviewSummary['status'], string> = { PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected' };


export function ReportsPage() {
  const { user } = useAuth();
  const can = useCan();
  const { toast } = useToast();
  const { formatDateTime } = useDatetimeFormat();
  const { defaultLimit } = usePaginationDefaults();
  const [list, setList] = useState<ReviewList>('queue');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultLimit);
  const [pending, setPending] = useState<{ review: ReviewSummary; decision: 'approve' | 'reject' } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  const qs = new URLSearchParams({ list, page: String(page), pageSize: String(pageSize) });
  const { data, error, isLoading, mutate } = useSWR<{ data: ReviewSummary[]; total: number }>(`/api/report-reviews?${qs}`);
  // Usernames for the Send-to column: a request names its assignee by id.
  const { data: usersData } = useSWR<any>(`/api/users?${ALL_RECORDS_PARAM}`);
  const users = useMemo(() => {
    const raw = Array.isArray(usersData) ? usersData : (usersData?.data ?? usersData?.users ?? []);
    return (raw as { id: string; username: string }[]).filter((u) => u.username);
  }, [usersData]);

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  const isAssignee = (r: ReviewSummary) =>
    !!user && ((r.assigneeUserId !== null && r.assigneeUserId === user.id) || (r.assigneeRole !== null && r.assigneeRole === user.role) || user.role === 'SUPER_ADMIN');
  // Mirrors the server's isSelfDecision: the requester never decides their own
  // request, SUPER_ADMIN excepted (operator, 2026-09-08). Presentation only —
  // the 403 in report-reviews/service.ts is the control.
  const isSelfDecision = (r: ReviewSummary) => user?.role !== 'SUPER_ADMIN' && r.requestedBy === user?.id;
  const mayDecide = (r: ReviewSummary) => r.status === 'PENDING' && can('reports.approve') && isAssignee(r) && !isSelfDecision(r);

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

  const view = async (r: ReviewSummary) => {
    try { await openDraft(r.id, formatDateTime); }
    catch (e: any) { toast.error('Could not open the draft', e?.message ?? 'Please try again.'); }
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
                  <TableRow key={r.id}>
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
                    <TableCell className="align-top">{assigneeText(r, users)}</TableCell>
                    <TableCell className="align-top"><StatusBadge tone={STATUS_TONE[r.status]} label={STATUS_WORD[r.status]} /></TableCell>
                    <TableCell className="align-top">
                      {r.decidedByName ? (
                        <>
                          <span className="block">{r.decidedByName}</span>
                          <span className="block text-xs text-slate-500">{r.decidedAt ? formatDateTime(r.decidedAt) : ''}</span>
                        </>
                      ) : '-'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap align-top text-right">
                      <div className="flex justify-end gap-1.5">
                        {/* The DRAFT is a thing to review, so it is offered only while
                            there is still a decision to make (operator, 2026-09-25:
                            "if request is approved or rejected then view draft should
                            not come"). An approved report downloads signed; a rejected
                            one is closed. */}
                        {r.status === 'PENDING' && (
                          <Button size="sm" variant="secondary" onClick={() => view(r)}>View draft</Button>
                        )}
                        {mayDecide(r) && (
                          <>
                            <Button size="sm" onClick={() => { setDialogError(''); setPending({ review: r, decision: 'approve' }); }}>Approve</Button>
                            <Button size="sm" variant="secondary" onClick={() => { setDialogError(''); setPending({ review: r, decision: 'reject' }); }}>Reject</Button>
                          </>
                        )}
                        {r.status === 'APPROVED' && (
                          <Button size="sm" onClick={() => download(r)}>Download</Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
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
