import { useEffect, useRef, useState } from 'react';
import useSWR, { mutate } from 'swr';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { Pagination } from '@/components/ui/pagination';
import { Button } from '@/components/ui/button';
import { PageHero } from '@/components/ui/page-hero';
import { Toolbar } from '@/components/ui/toolbar';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { SkeletonRows } from '@/components/ui/skeleton';

const TYPE_CFG: Record<string, { label: string; bg: string; text: string; border: string; icon: string }> = {
  CREATE_USER: { label: 'Create User', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', icon: '+' },
  MODIFY_USER: { label: 'Modify User', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', icon: '~' },
  UNLOCK: { label: 'Unlock Account', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', icon: '!' },
  FORGOT_PASSWORD: { label: 'Forgot Password', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', icon: '?' },
  // Enable/Disable (2026-09-02). Green for the one that restores access, slate for
  // the one that removes it — never red, which this page uses for Unlock, an
  // urgent-but-benign request. A disable is deliberate, not an alarm.
  ENABLE_ACCOUNT: { label: 'Enable Account', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', icon: '✓' },
  DISABLE_ACCOUNT: { label: 'Disable Account', bg: 'bg-slate-100', text: 'text-slate-700', border: 'border-slate-300', icon: '⊘' },
};

const STATUS_CFG: Record<string, { label: string; bg: string; text: string; border: string; dot: string }> = {
  PENDING: { label: 'Pending', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-400 animate-pulse' },
  APPROVED: { label: 'Approved', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-400' },
  REJECTED: { label: 'Rejected', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-400' },
};

// Full static class strings (no interpolation) so Tailwind's scanner keeps them.
/**
 * UI v3 (2026-09-21): the four filter cards read the `--status-*` tokens, so
 * "Pending" here is the same amber as a pending badge anywhere else. `cyan`
 * (All) is the theme's own colour. Keys unchanged — STAT_CARDS names them.
 */
const STAT_ACCENTS: Record<string, { iconBg: string; ring: string }> = {
  cyan: { iconBg: 'bg-[var(--theme-primary,#2a78d6)] text-white', ring: 'border-[var(--theme-primary,#2a78d6)] ring-2 ring-[var(--surface-tint-2)]' },
  amber: { iconBg: 'bg-[var(--status-warn-dot)] text-white', ring: 'border-[var(--status-warn-dot)] ring-2 ring-[var(--status-warn-bg)]' },
  emerald: { iconBg: 'bg-[var(--status-ok-dot)] text-white', ring: 'border-[var(--status-ok-dot)] ring-2 ring-[var(--status-ok-bg)]' },
  rose: { iconBg: 'bg-[var(--status-danger-dot)] text-white', ring: 'border-[var(--status-danger-dot)] ring-2 ring-[var(--status-danger-bg)]' },
};

const ICON = {
  inbox: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0l-2.5 5a2 2 0 01-1.8 1.1H8.3a2 2 0 01-1.8-1.1L4 13m16 0h-4.5l-1 2h-5l-1-2H4" /></svg>,
  clock: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  check: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  x: <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.6} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
};

const STAT_CARDS: { key: string; countKey: 'all' | 'PENDING' | 'APPROVED' | 'REJECTED'; label: string; accent: string; icon: React.ReactNode }[] = [
  { key: '', countKey: 'all', label: 'All Requests', accent: 'cyan', icon: ICON.inbox },
  { key: 'PENDING', countKey: 'PENDING', label: 'Pending', accent: 'amber', icon: ICON.clock },
  { key: 'APPROVED', countKey: 'APPROVED', label: 'Approved', accent: 'emerald', icon: ICON.check },
  { key: 'REJECTED', countKey: 'REJECTED', label: 'Rejected', accent: 'rose', icon: ICON.x },
];

export function AdminRequestsPage() {
  const can = useCan();
  const canApprove = can('admin_requests.approve');
  const canReject = can('admin_requests.reject');
  const { formatDateTime } = useDatetimeFormat();
  const { toast } = useToast();
  const reauth = useReauth();
  const [statusFilter, setStatusFilter] = useState('');
  const [search, setSearch] = useState('');
  const [selectedRequest, setSelectedRequest] = useState<any>(null);
  const [adminRemarks, setAdminRemarks] = useState('');
  const [processing, setProcessing] = useState(false);
  // `changed === false` means the approval was recorded but the account was
  // ALREADY in the state asked for, so nothing was done (operator, 2026-09-02).
  // Read from the server's answer, never re-derived here — the browser cannot know
  // what state the account was in.
  const [approvalResult, setApprovalResult] = useState<{ username?: string; temporaryPassword?: string; message?: string; requestType?: string; changed?: boolean } | null>(null);
  const [copied, setCopied] = useState<string>('');

  // A11y (M83): both overlays below are hand-rolled rather than the shared
  // `ui/dialog` (the slide-over is a right-edge panel, the result dialog has its
  // own gradient chrome), so they must bring their own Escape handling + focus
  // move — same pattern as components/ui/message-dialog.tsx. Without this a
  // keyboard user could open neither, and could not dismiss what they opened.
  const panelRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  // Escape closes the topmost overlay: the result dialog sits above the panel.
  useEffect(() => {
    if (!selectedRequest && !approvalResult) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (approvalResult) setApprovalResult(null);
      else setSelectedRequest(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedRequest, approvalResult]);

  // Move focus into each overlay when it opens so keyboard/AT users land inside
  // it (and so Escape reaches the handler above without a stray focus target).
  useEffect(() => { if (selectedRequest) panelRef.current?.focus(); }, [selectedRequest]);
  useEffect(() => { if (approvalResult) resultRef.current?.focus(); }, [approvalResult]);

  // Fetch the full set once and filter client-side. Server-side ?status= would
  // zero out the other buckets, making the status counts wrong while a filter
  // is active — so counts + filtering both run off the same full list here.
  const { data, isLoading } = useSWR('/api/admin-requests', { refreshInterval: 15000 });
  const allRequests: any[] = data?.data ?? [];
  const counts = {
    all: allRequests.length,
    PENDING: allRequests.filter((r) => r.status === 'PENDING').length,
    APPROVED: allRequests.filter((r) => r.status === 'APPROVED').length,
    REJECTED: allRequests.filter((r) => r.status === 'REJECTED').length,
  };
  const pendingCount = counts.PENDING;
  const q = search.trim().toLowerCase();
  const requests = allRequests.filter((r) =>
    (!statusFilter || r.status === statusFilter) &&
    (!q || (r.requesterName ?? '').toLowerCase().includes(q) || (r.requesterEmployeeId ?? '').toLowerCase().includes(q)));

  // Pagination — slice the filtered rows.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => { setPage(1); }, [statusFilter, search]);
  const totalPages = Math.max(1, Math.ceil(requests.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedRequests = requests.slice((safePage - 1) * pageSize, safePage * pageSize);

  const handleProcess = (action: 'approve' | 'reject') => {
    if (!selectedRequest) return;
    if (!adminRemarks.trim()) {
      toast.warning('Remarks Required', 'Please fill in your response before approving or rejecting.');
      return;
    }
    setProcessing(true);
    let response: any = null;
    const reqType = selectedRequest.requestType;
    // M1 (audit 2026-05-04): APPROVE_ADMIN_REQUEST replaces the previous
    // CREATE_USER reauth action so password-reset / unlock / modify-user
    // approvals don't get logged under a misleading "create user" key.
    reauth.execute(
      'APPROVE_ADMIN_REQUEST',
      async (password?: string) => {
        const body = { action, adminRemarks: adminRemarks.trim() };
        if (password) {
          response = await apiClient.postWithReauth(`/api/admin-requests/${selectedRequest.id}/process`, body, password);
        } else {
          response = await apiClient.post(`/api/admin-requests/${selectedRequest.id}/process`, body);
        }
      },
      {
        onSuccess: () => {
          const hasCreds = action === 'approve' && (response?.temporaryPassword || response?.username);
          if (hasCreds) {
            setApprovalResult({
              username: response.username,
              temporaryPassword: response.temporaryPassword,
              message: response.message,
              requestType: reqType,
              // The server's answer, carried verbatim. A no-op approval returns a
              // username (so this dialog opens) but performed nothing.
              changed: response.changed,
            });
          } else {
            toast.success(
              action === 'approve' ? 'Request Approved' : 'Request Rejected',
              `${TYPE_CFG[reqType]?.label} request has been ${action === 'approve' ? 'approved' : 'rejected'}.`,
            );
          }
          setSelectedRequest(null);
          setAdminRemarks('');
          setProcessing(false);
          mutate('/api/admin-requests');
        },
        // A cancelled password is not an error: nothing was sent.
        onCancel: () => { setProcessing(false); },
        onError: (err: any) => {
          toast.error('Action Failed', err.message ?? 'Something went wrong');
          setProcessing(false);
        },
      },
    );
  };

  const copyToClipboard = (text: string, key: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(''), CLIPBOARD_COPY_RESET_MS);
    });
  };

  const timeAgo = (date: string) => {
    const ms = Date.now() - new Date(date).getTime();
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const renderRequestDetails = (req: any) => {
    const rd = req.requestData ?? {};
    const fields: [string, string][] = [];
    switch (req.requestType) {
      case 'CREATE_USER':
        fields.push(['User ID', rd.username || '(auto-generated)'], ['Full Name', rd.fullName], ['Email', rd.email], ['Department', rd.department || '-'], ['Requested Role', rd.requestedRole]);
        break;
      case 'MODIFY_USER':
        fields.push(['Username', rd.username], ['Modify Field', rd.modifyField], ['New Value', rd.newValue]);
        break;
      case 'UNLOCK':
      case 'FORGOT_PASSWORD':
      case 'ENABLE_ACCOUNT':
      case 'DISABLE_ACCOUNT':
        fields.push(['Username', rd.username]);
        break;
      default:
        return <pre className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">{JSON.stringify(rd, null, 2)}</pre>;
    }
    return (
      <div className="grid grid-cols-2 gap-3">
        {fields.map(([label, value]) => (
          <div key={label} className="space-y-0.5">
            <div className="text-[0.6875rem] text-slate-400 uppercase tracking-wider font-medium">{label}</div>
            <div className="text-[0.8125rem] font-medium text-slate-800">{value}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-100 bg-white shrink-0 space-y-4">
        {/* UI v3 (2026-09-21): the shared band, the search inside it. */}
        <PageHero
          title="Admin Requests"
          crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Admin Requests' }]}
          icon={
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          }
        >
          <Toolbar
            className="border-0 bg-transparent p-0 shadow-none"
            search={{ name: 'admin-request-search', label: 'Search requests', placeholder: 'Search requester or ID…', value: search, onChange: setSearch }}
            trailing={search ? (
              <Button variant="ghost" size="sm" type="button" className="text-white hover:bg-white/15 hover:text-white" onClick={() => setSearch('')}>
                Clear
              </Button>
            ) : undefined}
          />
        </PageHero>

        {/* Stat / filter cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {STAT_CARDS.map((c) => {
            const active = statusFilter === c.key;
            const a = STAT_ACCENTS[c.accent];
            return (
              // aria-pressed carries the active state that is otherwise only
              // conveyed by the accent ring.
              <button key={c.key} onClick={() => setStatusFilter(c.key)} aria-pressed={active}
                className={`flex items-center gap-3 p-3.5 rounded-xl border bg-white text-left transition-all ${active ? `${a.ring} shadow-[var(--elev-1)]` : 'border-slate-200 hover:border-slate-300 hover:shadow-[var(--elev-1)]'}`}>
                <span className={`grid place-items-center w-10 h-10 rounded-lg shrink-0 ${a.iconBg}`}>{c.icon}</span>
                <div className="min-w-0">
                  <div className="text-xl font-bold text-slate-800 tabular-nums leading-none">{counts[c.countKey]}</div>
                  <div className="text-[0.75rem] text-slate-500 mt-1 truncate">{c.label}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          // The request rows are what is coming, so that is what stands in for
          // them — a centred spinner in a tall empty pane predicts nothing.
          <div className="p-4">
            <SkeletonRows rows={5} columns={4} />
          </div>
        ) : requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <svg className="w-14 h-14 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            {allRequests.length === 0 ? (
              <>
                <span className="text-slate-400 font-medium text-[0.875rem]">No requests found</span>
                <span className="text-[0.8125rem] text-slate-300">Requests will appear when users submit them</span>
              </>
            ) : (
              <>
                <span className="text-slate-400 font-medium text-[0.875rem]">No matching requests</span>
                <span className="text-[0.8125rem] text-slate-300">Try a different filter or search term</span>
                <Button variant="ghost" size="sm" className="mt-1" onClick={() => { setStatusFilter(''); setSearch(''); }}>Clear filters</Button>
              </>
            )}
          </div>
        ) : (
          <Table>
            <TableHeader>
              <tr>
                {['Requester', 'Type', 'Status', 'Submitted', 'Time', ''].map((h, i) => (
                  // The last header is the empty action column — it labels no
                  // column of data, so it gets no scope (an unscoped empty th is
                  // announced as a stray column header by screen readers).
                  <TableHead key={i} scope={h ? 'col' : undefined} className="whitespace-nowrap">{h}</TableHead>
                ))}
              </tr>
            </TableHeader>
            <TableBody>
              {pagedRequests.map((req: any) => {
                const tc = TYPE_CFG[req.requestType] ?? { label: req.requestType, bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200', icon: '?' };
                const sc = STATUS_CFG[req.status] ?? { label: req.status, bg: 'bg-slate-50', text: 'text-slate-600', border: 'border-slate-200', dot: 'bg-slate-400' };
                const isPending = req.status === 'PENDING';

                const openRequest = () => { setSelectedRequest(req); setAdminRemarks(''); setProcessing(false); };

                return (
                  // M83: the row is the ONLY way to open a request, so it must be
                  // reachable and activatable by keyboard — pre-fix it was
                  // `onClick`-only, which locked keyboard/AT users out of the
                  // approval queue entirely. role=button + tabIndex + Enter/Space
                  // is the standard non-native-control pattern.
                  <TableRow key={req.id} className={`group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--theme-primary,#2a78d6)] ${isPending ? 'bg-[var(--status-warn-bg)]' : ''}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`${isPending ? 'Review' : 'View'} ${tc.label} request from ${req.requesterName}`}
                    onClick={openRequest}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault(); // Space would otherwise scroll the table
                        openRequest();
                      }
                    }}>
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="grid place-items-center w-9 h-9 rounded-full bg-cyan-100 text-cyan-700 font-bold text-[0.8125rem] shrink-0">
                          {(req.requesterName ?? '?')[0].toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[0.8125rem] font-semibold text-slate-800 truncate">{req.requesterName}</div>
                          {req.requesterEmployeeId && <div className="text-[0.6875rem] text-slate-400">{req.requesterEmployeeId}</div>}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 text-[0.6875rem] px-2.5 py-1 rounded-full border font-bold ${tc.bg} ${tc.text} ${tc.border}`}>
                        <span className="grid place-items-center w-4 h-4 rounded-full bg-white/70 text-[0.625rem] leading-none">{tc.icon}</span>
                        {tc.label}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={`inline-flex items-center gap-1.5 text-[0.6875rem] px-2.5 py-1 rounded-full border font-bold ${sc.bg} ${sc.text} ${sc.border}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {sc.label}
                      </span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-[0.8125rem] tabular-nums text-slate-600">{formatDateTime(req.requestedAt)}</TableCell>
                    <TableCell className="text-[0.75rem] text-slate-400">{timeAgo(req.requestedAt)}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-cyan-600 opacity-60 group-hover:opacity-100 transition-opacity">
                        {isPending ? 'Review' : 'View'}
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      </span>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      {/* Pagination footer */}
      {!isLoading && requests.length > 0 && (
        <Pagination
          className="border-t border-slate-200 bg-slate-50/60 shrink-0"
          page={safePage}
          pageSize={pageSize}
          totalItems={requests.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}

      {/* Slide-over panel */}
      {selectedRequest && (
        <>
          <div className="fixed inset-0 bg-black/30 z-40 transition-opacity" onClick={() => setSelectedRequest(null)} />
          <div
            ref={panelRef}
            tabIndex={-1}
            role="dialog"
            aria-modal="true"
            aria-label={`${TYPE_CFG[selectedRequest.requestType]?.label ?? selectedRequest.requestType} request from ${selectedRequest.requesterName}`}
            className="fixed top-0 right-0 h-full w-[480px] bg-white shadow-[var(--elev-3)] z-50 flex flex-col border-l border-slate-200 focus:outline-none"
          >
            {/* Panel header */}
            <div className="px-6 py-4 border-b border-slate-100">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${TYPE_CFG[selectedRequest.requestType]?.bg ?? 'bg-slate-50'} ${TYPE_CFG[selectedRequest.requestType]?.text ?? 'text-slate-600'}`}>
                    {TYPE_CFG[selectedRequest.requestType]?.icon ?? '?'}
                  </div>
                  <div>
                    <h3 className="text-[0.9375rem] font-bold text-slate-800">
                      {TYPE_CFG[selectedRequest.requestType]?.label ?? selectedRequest.requestType}
                    </h3>
                    <p className="text-[0.6875rem] text-slate-400">{timeAgo(selectedRequest.requestedAt)}</p>
                  </div>
                </div>
                <Button variant="ghost" size="icon" onClick={() => setSelectedRequest(null)} aria-label="Close request details">
                  <svg aria-hidden="true" className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </Button>
              </div>
              {/* Status badge */}
              <span className={`inline-flex items-center gap-1.5 text-[0.6875rem] px-2.5 py-1 rounded-full border font-bold ${STATUS_CFG[selectedRequest.status]?.bg ?? ''} ${STATUS_CFG[selectedRequest.status]?.text ?? ''} ${STATUS_CFG[selectedRequest.status]?.border ?? ''}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CFG[selectedRequest.status]?.dot ?? ''}`} />
                {STATUS_CFG[selectedRequest.status]?.label ?? selectedRequest.status}
              </span>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Requester */}
              <div>
                <h4 className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-2">Requester</h4>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <div className="w-10 h-10 rounded-full bg-cyan-100 flex items-center justify-center text-cyan-600 font-bold text-sm">
                    {(selectedRequest.requesterName ?? '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-[0.8125rem] font-semibold text-slate-800">{selectedRequest.requesterName}</div>
                    {selectedRequest.requesterEmployeeId && <div className="text-[0.6875rem] text-slate-400">{selectedRequest.requesterEmployeeId}</div>}
                    {selectedRequest.requesterEmail && <div className="text-[0.6875rem] text-slate-400">{selectedRequest.requesterEmail}</div>}
                  </div>
                </div>
              </div>

              {/* Request data */}
              <div>
                <h4 className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-2">Details</h4>
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                  {renderRequestDetails(selectedRequest)}
                </div>
              </div>

              {/* Timestamps */}
              <div>
                <h4 className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-2">Timeline</h4>
                <div className="space-y-2">
                  <div className="flex items-center gap-3 text-[0.8125rem]">
                    <div className="w-2 h-2 rounded-full bg-blue-400" />
                    <span className="text-slate-500">Submitted</span>
                    <span className="text-slate-700 font-medium ml-auto tabular-nums">{formatDateTime(selectedRequest.requestedAt)}</span>
                  </div>
                  {selectedRequest.processedAt && (
                    <div className="flex items-center gap-3 text-[0.8125rem]">
                      <div className={`w-2 h-2 rounded-full ${selectedRequest.status === 'APPROVED' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                      <span className="text-slate-500">{selectedRequest.status === 'APPROVED' ? 'Approved' : 'Rejected'}</span>
                      <span className="text-slate-700 font-medium ml-auto tabular-nums">{formatDateTime(selectedRequest.processedAt)}</span>
                    </div>
                  )}
                  {selectedRequest.processedBy && (
                    <div className="flex items-center gap-3 text-[0.8125rem]">
                      <div className="w-2 h-2 rounded-full bg-slate-300" />
                      <span className="text-slate-500">Processed by</span>
                      <span className="text-slate-700 font-medium ml-auto">{selectedRequest.processedBy}</span>
                    </div>
                  )}
                </div>
              </div>

              {/* Requester remarks */}
              {selectedRequest.remarks && (
                <div>
                  <h4 className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-2">Requester's Reason</h4>
                  <p className="text-[0.8125rem] text-slate-600 p-3 rounded-xl bg-slate-50 border border-slate-100 italic">{selectedRequest.remarks}</p>
                </div>
              )}

              {/* Admin remarks (processed) */}
              {selectedRequest.adminRemarks && (
                <div>
                  <h4 className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-2">Admin Notes</h4>
                  <p className="text-[0.8125rem] text-slate-600 p-3 rounded-xl bg-slate-50 border border-slate-100">{selectedRequest.adminRemarks}</p>
                </div>
              )}

              {/* Admin response textarea */}
              {(canApprove || canReject) && selectedRequest.status === 'PENDING' && (
                <div>
                  <h4 className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-2">Your Response <span className="text-red-500">*</span></h4>
                  <textarea
                    value={adminRemarks}
                    onChange={e => setAdminRemarks(e.target.value)}
                    placeholder="Enter notes about your decision (required)..."
                    rows={3}
                    className="ctl w-full resize-none"
                  />
                </div>
              )}
            </div>

            {/* Footer actions */}
            {(canApprove || canReject) && selectedRequest.status === 'PENDING' && (
              <div className="px-6 py-4 border-t border-slate-100 bg-white flex items-center gap-3">
                {canReject && (
                  <Button variant="destructive" className="flex-1" onClick={() => handleProcess('reject')} disabled={processing}>
                    {processing ? 'Processing...' : 'Reject'}
                  </Button>
                )}
                {canApprove && (
                  <Button variant="success" className="flex-1" onClick={() => handleProcess('approve')} disabled={processing}>
                    {processing ? 'Processing...' : 'Approve'}
                  </Button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setProcessing(false); }}
        actionLabel="Process Request"
      />

      {/* Approval result dialog — shows temporary password/username for admin to share */}
      {approvalResult && (
        <>
          <div className="fixed inset-0 bg-black/50 z-[55]" />
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
            <div
              ref={resultRef}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label="Request processed"
              className="bg-white rounded-[var(--radius-card)] shadow-[var(--elev-3)] w-full max-w-md overflow-hidden focus:outline-none"
            >
              {/*
                A no-op approval gets its OWN heading and colour. The green tick and
                "Request Approved" over "Account X was not locked" is the defect the
                operator reported — the dialog asserted an action the system had
                deliberately not performed. Slate + an information glyph, because
                nothing went wrong either: the request was answered, and the answer
                is that there was nothing to do.
              */}
              <div className={`px-6 py-5 text-white ${approvalResult.changed === false
                ? 'bg-gradient-to-br from-slate-500 to-slate-600'
                : 'bg-gradient-to-br from-emerald-500 to-teal-600'}`}>
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      {approvalResult.changed === false
                        ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />}
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">
                      {approvalResult.changed === false ? 'Approved — no change needed' : 'Request Approved'}
                    </h3>
                    <p className="text-[0.75rem] text-white/80">{approvalResult.message ?? 'Action completed successfully.'}</p>
                  </div>
                </div>
              </div>
              <div className="p-6 space-y-4">
                {approvalResult.temporaryPassword && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[0.75rem] text-amber-800">
                    <strong>Share these credentials with the user.</strong> They won't be shown again. The user must change the password on first login.
                  </div>
                )}
                {approvalResult.username && (
                  <div>
                    <label className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider">Username</label>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="flex-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[0.8125rem] text-slate-800 font-mono">{approvalResult.username}</code>
                      <Button variant="secondary" size="sm"
                        onClick={() => copyToClipboard(approvalResult.username!, 'username')}
                        // Both copy buttons render the bare word "Copy" — without
                        // a label they are indistinguishable out of visual context.
                        aria-label="Copy username"
                      >
                        {copied === 'username' ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>
                )}
                {approvalResult.temporaryPassword && (
                  <div>
                    <label className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider">Temporary Password</label>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="flex-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[0.8125rem] text-slate-800 font-mono">{approvalResult.temporaryPassword}</code>
                      <Button variant="secondary" size="sm"
                        onClick={() => copyToClipboard(approvalResult.temporaryPassword!, 'password')}
                        aria-label="Copy temporary password"
                      >
                        {copied === 'password' ? 'Copied' : 'Copy'}
                      </Button>
                    </div>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-slate-100 flex justify-end">
                <Button 
                  onClick={() => { setApprovalResult(null); setCopied(''); }}
                >
                  Done
                </Button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
