import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { useCan } from '@/hooks/use-can';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useAuth } from '@/hooks/use-auth';
import { downloadReview, canDownloadReview, type ReviewSummary } from '@/lib/report-review';

const STATUS_CHIP: Record<string, string> = {
  PENDING_REVIEW: 'bg-sky-50 text-sky-700 border-sky-200',
  PENDING_APPROVAL: 'bg-amber-50 text-amber-700 border-amber-200',
  APPROVED: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  REJECTED: 'bg-rose-50 text-rose-700 border-rose-200',
};
const STATUS_LABEL: Record<string, string> = {
  PENDING_REVIEW: 'To Review', PENDING_APPROVAL: 'To Approve', APPROVED: 'Approved', REJECTED: 'Rejected',
};

interface Role { name: string; displayName: string; }

export function ReportReviewsPage() {
  const { toast } = useToast();
  const { user } = useAuth();
  const reauth = useReauth();
  const can = useCan();
  const { formatDate } = useDatetimeFormat();
  const [tab, setTab] = useState<'queue' | 'all'>('queue');

  const { data: queueData, mutate: mutateQueue } = useSWR<{ data: ReviewSummary[] }>('/api/report-reviews/queue', { refreshInterval: 30000 });
  const { data: allData, mutate: mutateAll } = useSWR<{ data: ReviewSummary[] }>('/api/report-reviews');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active');
  const roles = useMemo(() => (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN'), [rolesData]);

  const queue = queueData?.data ?? [];
  const all = allData?.data ?? [];

  // Action dialog state.
  const [dlg, setDlg] = useState<{ item: ReviewSummary; action: 'approve' | 'reject' } | null>(null);
  const [remarks, setRemarks] = useState('');
  const [approverRole, setApproverRole] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = () => { mutateQueue(); mutateAll(); };

  const openDlg = (item: ReviewSummary, action: 'approve' | 'reject') => {
    setDlg({ item, action }); setRemarks(''); setApproverRole('');
  };

  const submit = () => {
    if (!dlg) return;
    const { item, action } = dlg;
    const isReview = item.stage === 'REVIEW';
    if (action === 'reject' && remarks.trim().length < 3) { toast.error('Remarks required', 'Add at least 3 characters.'); return; }
    if (isReview && action === 'approve' && !approverRole) { toast.error('Approver required', 'Choose a role to approve this.'); return; }

    const url = `/api/report-reviews/${item.id}/${isReview ? 'review' : 'approve'}`;
    const body: Record<string, unknown> = { action, remarks: remarks.trim() || undefined };
    if (isReview && action === 'approve') body.assigneeRole = approverRole;
    const reauthAction = isReview ? 'REVIEW_REPORT' : 'APPROVE_REPORT';

    setBusy(true);
    reauth.execute(reauthAction, async (pw?: string) => {
      if (pw) await apiClient.postWithReauth(url, body, pw);
      else await apiClient.post(url, body);
    }, {
      onSuccess: () => {
        toast.success('Done', action === 'approve' ? (isReview ? 'Sent for approval' : 'Report approved') : 'Report rejected');
        setDlg(null); setBusy(false); refresh();
      },
      onError: (e: any) => { toast.error('Failed', e?.message ?? 'Action failed'); setBusy(false); },
    });
  };

  const download = async (item: ReviewSummary) => {
    try { await downloadReview(item.id, (d) => formatDate(d)); }
    catch (e: any) { toast.error('Download failed', e?.message ?? 'Could not build PDF'); }
  };

  const Row = ({ r, inQueue }: { r: ReviewSummary; inQueue: boolean }) => {
    // Phase 5C gating: Reject routes through the SAME endpoint as the primary action
    // (/review for REVIEW-stage, /approve for approval-stage), so both buttons share
    // the same stage-dependent gate. The report_reviews.reject tree node (gate
    // ['REPORT_APPROVE']) is NOT used directly — it doesn't model the review-stage
    // reject case and would silently strip Reject from REPORT_REVIEW-only users.
    const canAct = r.stage === 'REVIEW'
      ? can('report_reviews.review')   // /review endpoint — requires REPORT_REVIEW
      : can('report_reviews.approve'); // /approve endpoint — requires REPORT_APPROVE
    return (
      <div className="grid grid-cols-[1.6fr_1fr_1fr_auto] items-center gap-3 px-4 py-3 hover:bg-slate-50/50">
        <div>
          <div className="text-[14px] font-medium text-slate-800">{r.title}</div>
          <div className="text-[11px] text-slate-400">{r.reportType}{r.subtitle ? ` · ${r.subtitle}` : ''}</div>
        </div>
        <div className="text-[12px] text-slate-600">
          <div>By: <span className="font-mono">{r.generatedByName}</span></div>
          {r.reviewedByName && <div>Reviewed: <span className="font-mono">{r.reviewedByName}</span></div>}
          {r.approvedByName && <div>Approved: <span className="font-mono">{r.approvedByName}</span></div>}
        </div>
        <div>
          <span className={`inline-block text-[11px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_CHIP[r.status] ?? 'bg-slate-100 text-slate-500 border-slate-200'}`}>
            {inQueue && r.stage ? (r.stage === 'REVIEW' ? 'Review now' : 'Approve now') : (STATUS_LABEL[r.status] ?? r.status)}
          </span>
          {r.status === 'REJECTED' && (r.reviewRemarks || r.approvalRemarks) && (
            <div className="text-[11px] text-rose-500 mt-1">{r.approvalRemarks || r.reviewRemarks}</div>
          )}
        </div>
        <div className="flex items-center gap-2 justify-end">
          {inQueue ? (
            <>
              {canAct && (
                <button onClick={() => openDlg(r, 'approve')} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700">
                  {r.stage === 'REVIEW' ? 'Review' : 'Approve'}
                </button>
              )}
              {canAct && (
                <button onClick={() => openDlg(r, 'reject')} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-rose-600 border border-rose-200 hover:bg-rose-50">Reject</button>
              )}
            </>
          ) : (
            can('report_reviews.view') && canDownloadReview(user, r) && (
              <button onClick={() => download(r)} className="px-3 py-1.5 rounded-lg text-[12px] font-semibold text-slate-700 border border-slate-200 hover:bg-slate-50">Download PDF</button>
            )
          )}
        </div>
      </div>
    );
  };

  const list = tab === 'queue' ? queue : all;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <h1 className="text-2xl font-bold text-slate-800">Report Reviews</h1>
      <p className="text-sm text-slate-500 mt-1 mb-5">Reports sent for review/approval. Approved reports carry Printed By / Reviewed By / Approved By when downloaded.</p>

      <div className="flex items-center gap-2 mb-4">
        <button onClick={() => setTab('queue')} className={`px-4 py-2 rounded-lg text-sm font-semibold ${tab === 'queue' ? 'text-white bg-gradient-to-r from-teal-500 to-cyan-600' : 'text-slate-600 bg-slate-100'}`}>
          To Action {queue.length > 0 && <span className="ml-1 px-1.5 rounded-full bg-white/30 text-[11px]">{queue.length}</span>}
        </button>
        <button onClick={() => setTab('all')} className={`px-4 py-2 rounded-lg text-sm font-semibold ${tab === 'all' ? 'text-white bg-gradient-to-r from-teal-500 to-cyan-600' : 'text-slate-600 bg-slate-100'}`}>All Reports</button>
      </div>

      <div className="border border-slate-200 rounded-xl bg-white overflow-hidden divide-y divide-slate-100">
        {list.length === 0 ? (
          <div className="text-sm text-slate-400 py-12 text-center">{tab === 'queue' ? 'Nothing awaiting your action.' : 'No reports yet.'}</div>
        ) : (
          list.map((r) => <Row key={r.id} r={r} inQueue={tab === 'queue'} />)
        )}
      </div>

      {/* Action dialog */}
      {dlg && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setDlg(null)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 rounded-t-2xl text-white" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
              <h3 className="font-bold">{dlg.action === 'approve' ? (dlg.item.stage === 'REVIEW' ? 'Review report' : 'Approve report') : 'Reject report'}</h3>
              <p className="text-white/80 text-[12px] mt-0.5">{dlg.item.title}</p>
            </div>
            <div className="p-6 space-y-4">
              {dlg.item.stage === 'REVIEW' && dlg.action === 'approve' && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Send to (approver role)</label>
                  <select value={approverRole} onChange={(e) => setApproverRole(e.target.value)}
                    className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500/30">
                    <option value="">Select a role…</option>
                    {roles.map((r) => <option key={r.name} value={r.name}>{r.displayName || r.name}</option>)}
                  </select>
                </div>
              )}
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Remarks {dlg.action === 'reject' && <span className="text-rose-500">*</span>}</label>
                <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={3}
                  className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
                  placeholder={dlg.action === 'reject' ? 'Reason for rejection (required)' : 'Optional remarks'} />
              </div>
            </div>
            <div className="px-6 py-4 bg-slate-50 rounded-b-2xl flex justify-end gap-2">
              <button onClick={() => setDlg(null)} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
              <button onClick={submit} disabled={busy}
                className={`px-4 py-2 rounded-lg text-sm font-semibold text-white disabled:opacity-50 ${dlg.action === 'reject' ? 'bg-rose-600 hover:bg-rose-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
                {busy ? 'Working…' : (dlg.action === 'reject' ? 'Reject' : 'Confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={() => { reauth.cancel(); setBusy(false); }} />
    </div>
  );
}
