import { useEffect, useRef, useState } from 'react';
import useSWR, { mutate } from 'swr';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useToast } from '@/hooks/use-toast';
import { api } from '@/lib/api-client';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { Pagination } from '@/components/ui/pagination';

const TYPE_CFG: Record<string, { label: string; bg: string; text: string; border: string; icon: string }> = {
  CREATE_USER: { label: 'Create User', bg: 'bg-blue-50', text: 'text-blue-700', border: 'border-blue-200', icon: '+' },
  MODIFY_USER: { label: 'Modify User', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', icon: '~' },
  UNLOCK: { label: 'Unlock Account', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', icon: '!' },
  FORGOT_PASSWORD: { label: 'Forgot Password', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200', icon: '?' },
};

const STATUS_CFG: Record<string, { label: string; bg: string; text: string; border: string; dot: string }> = {
  PENDING: { label: 'Pending', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200', dot: 'bg-amber-400 animate-pulse' },
  APPROVED: { label: 'Approved', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200', dot: 'bg-emerald-400' },
  REJECTED: { label: 'Rejected', bg: 'bg-red-50', text: 'text-red-700', border: 'border-red-200', dot: 'bg-red-400' },
};

// Full static class strings (no interpolation) so Tailwind's scanner keeps them.
const STAT_ACCENTS: Record<string, { iconBg: string; ring: string }> = {
  cyan: { iconBg: 'bg-cyan-50 text-cyan-600', ring: 'border-cyan-300 ring-2 ring-cyan-100' },
  amber: { iconBg: 'bg-amber-50 text-amber-600', ring: 'border-amber-300 ring-2 ring-amber-100' },
  emerald: { iconBg: 'bg-emerald-50 text-emerald-600', ring: 'border-emerald-300 ring-2 ring-emerald-100' },
  rose: { iconBg: 'bg-rose-50 text-rose-600', ring: 'border-rose-300 ring-2 ring-rose-100' },
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
  const [approvalResult, setApprovalResult] = useState<{ username?: string; temporaryPassword?: string; message?: string; requestType?: string } | null>(null);
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
          response = await api.postWithReauth(`/api/admin-requests/${selectedRequest.id}/process`, body, password);
        } else {
          response = await api.post(`/api/admin-requests/${selectedRequest.id}/process`, body);
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
        fields.push(['Username', rd.username]);
        break;
      default:
        return <pre className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3">{JSON.stringify(rd, null, 2)}</pre>;
    }
    return (
      <div className="grid grid-cols-2 gap-3">
        {fields.map(([label, value]) => (
          <div key={label} className="space-y-0.5">
            <div className="text-[11px] text-slate-400 uppercase tracking-wider font-medium">{label}</div>
            <div className="text-[13px] font-medium text-slate-800">{value}</div>
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="px-6 pt-5 pb-4 border-b border-slate-100 bg-white shrink-0 space-y-4">
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl shadow-lg" style={{ backgroundImage: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800 tracking-tight">Admin Requests</h1>
              <p className="text-[13px] text-slate-400 mt-0.5">
                {pendingCount > 0 ? (
                  <><span className="text-amber-600 font-semibold">{pendingCount} pending</span> request{pendingCount !== 1 ? 's' : ''} awaiting review</>
                ) : 'All requests have been processed'}
              </p>
            </div>
          </div>

          {/* Search */}
          <div className="relative w-full sm:w-72">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35M17 11a6 6 0 11-12 0 6 6 0 0112 0z" />
            </svg>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search requester or ID…"
              className="w-full pl-9 pr-8 py-2 text-[13px] border border-slate-200 rounded-lg bg-white text-slate-700 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-400"
            />
            {search && (
              <button onClick={() => setSearch('')} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500 text-lg leading-none">×</button>
            )}
          </div>
        </div>

        {/* Stat / filter cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {STAT_CARDS.map((c) => {
            const active = statusFilter === c.key;
            const a = STAT_ACCENTS[c.accent];
            return (
              // aria-pressed carries the active state that is otherwise only
              // conveyed by the accent ring.
              <button key={c.key} onClick={() => setStatusFilter(c.key)} aria-pressed={active}
                className={`flex items-center gap-3 p-3.5 rounded-xl border bg-white text-left transition-all ${active ? `${a.ring} shadow-sm` : 'border-slate-200 hover:border-slate-300 hover:shadow-sm'}`}>
                <span className={`grid place-items-center w-10 h-10 rounded-lg shrink-0 ${a.iconBg}`}>{c.icon}</span>
                <div className="min-w-0">
                  <div className="text-xl font-bold text-slate-800 tabular-nums leading-none">{counts[c.countKey]}</div>
                  <div className="text-[12px] text-slate-500 mt-1 truncate">{c.label}</div>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[13px] text-slate-400">Loading requests...</span>
          </div>
        ) : requests.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-3">
            <svg className="w-14 h-14 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            {allRequests.length === 0 ? (
              <>
                <span className="text-slate-400 font-medium text-[14px]">No requests found</span>
                <span className="text-[13px] text-slate-300">Requests will appear when users submit them</span>
              </>
            ) : (
              <>
                <span className="text-slate-400 font-medium text-[14px]">No matching requests</span>
                <span className="text-[13px] text-slate-300">Try a different filter or search term</span>
                <button onClick={() => { setStatusFilter(''); setSearch(''); }}
                  className="mt-1 text-[12px] font-semibold text-cyan-600 hover:text-cyan-700">Clear filters</button>
              </>
            )}
          </div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 z-10">
              <tr className="bg-slate-50 border-b border-slate-200">
                {['Requester', 'Type', 'Status', 'Submitted', 'Time', ''].map((h, i) => (
                  // The last header is the empty action column — it labels no
                  // column of data, so it gets no scope (an unscoped empty th is
                  // announced as a stray column header by screen readers).
                  <th key={i} scope={h ? 'col' : undefined} className="text-left px-5 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap bg-slate-50">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 bg-white">
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
                  <tr key={req.id} className={`hover:bg-cyan-50/30 transition-colors group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-cyan-500 ${isPending ? 'bg-amber-50/20' : ''}`}
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
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-3">
                        <span className="grid place-items-center w-9 h-9 rounded-full bg-cyan-100 text-cyan-700 font-bold text-[13px] shrink-0">
                          {(req.requesterName ?? '?')[0].toUpperCase()}
                        </span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold text-slate-800 truncate">{req.requesterName}</div>
                          {req.requesterEmployeeId && <div className="text-[11px] text-slate-400">{req.requesterEmployeeId}</div>}
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-bold ${tc.bg} ${tc.text} ${tc.border}`}>
                        <span className="grid place-items-center w-4 h-4 rounded-full bg-white/70 text-[10px] leading-none">{tc.icon}</span>
                        {tc.label}
                      </span>
                    </td>
                    <td className="px-5 py-3.5">
                      <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-bold ${sc.bg} ${sc.text} ${sc.border}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${sc.dot}`} />
                        {sc.label}
                      </span>
                    </td>
                    <td className="px-5 py-3.5 text-[13px] text-slate-600 whitespace-nowrap tabular-nums">{formatDateTime(req.requestedAt)}</td>
                    <td className="px-5 py-3.5 text-[12px] text-slate-400">{timeAgo(req.requestedAt)}</td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-cyan-600 opacity-60 group-hover:opacity-100 transition-opacity">
                        {isPending ? 'Review' : 'View'}
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
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
            className="fixed top-0 right-0 h-full w-[480px] bg-white shadow-2xl z-50 flex flex-col border-l border-slate-200 focus:outline-none"
          >
            {/* Panel header */}
            <div className="px-6 py-4 border-b border-slate-100">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-sm font-bold ${TYPE_CFG[selectedRequest.requestType]?.bg ?? 'bg-slate-50'} ${TYPE_CFG[selectedRequest.requestType]?.text ?? 'text-slate-600'}`}>
                    {TYPE_CFG[selectedRequest.requestType]?.icon ?? '?'}
                  </div>
                  <div>
                    <h3 className="text-[15px] font-bold text-slate-800">
                      {TYPE_CFG[selectedRequest.requestType]?.label ?? selectedRequest.requestType}
                    </h3>
                    <p className="text-[11px] text-slate-400">{timeAgo(selectedRequest.requestedAt)}</p>
                  </div>
                </div>
                <button onClick={() => setSelectedRequest(null)} aria-label="Close request details" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
                  <svg aria-hidden="true" className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
              {/* Status badge */}
              <span className={`inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border font-bold ${STATUS_CFG[selectedRequest.status]?.bg ?? ''} ${STATUS_CFG[selectedRequest.status]?.text ?? ''} ${STATUS_CFG[selectedRequest.status]?.border ?? ''}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CFG[selectedRequest.status]?.dot ?? ''}`} />
                {STATUS_CFG[selectedRequest.status]?.label ?? selectedRequest.status}
              </span>
            </div>

            {/* Panel body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Requester */}
              <div>
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Requester</h4>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-slate-50 border border-slate-100">
                  <div className="w-10 h-10 rounded-full bg-cyan-100 flex items-center justify-center text-cyan-600 font-bold text-sm">
                    {(selectedRequest.requesterName ?? '?')[0].toUpperCase()}
                  </div>
                  <div>
                    <div className="text-[13px] font-semibold text-slate-800">{selectedRequest.requesterName}</div>
                    {selectedRequest.requesterEmployeeId && <div className="text-[11px] text-slate-400">{selectedRequest.requesterEmployeeId}</div>}
                    {selectedRequest.requesterEmail && <div className="text-[11px] text-slate-400">{selectedRequest.requesterEmail}</div>}
                  </div>
                </div>
              </div>

              {/* Request data */}
              <div>
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Details</h4>
                <div className="p-4 rounded-xl bg-slate-50 border border-slate-100">
                  {renderRequestDetails(selectedRequest)}
                </div>
              </div>

              {/* Timestamps */}
              <div>
                <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Timeline</h4>
                <div className="space-y-2">
                  <div className="flex items-center gap-3 text-[13px]">
                    <div className="w-2 h-2 rounded-full bg-blue-400" />
                    <span className="text-slate-500">Submitted</span>
                    <span className="text-slate-700 font-medium ml-auto tabular-nums">{formatDateTime(selectedRequest.requestedAt)}</span>
                  </div>
                  {selectedRequest.processedAt && (
                    <div className="flex items-center gap-3 text-[13px]">
                      <div className={`w-2 h-2 rounded-full ${selectedRequest.status === 'APPROVED' ? 'bg-emerald-400' : 'bg-red-400'}`} />
                      <span className="text-slate-500">{selectedRequest.status === 'APPROVED' ? 'Approved' : 'Rejected'}</span>
                      <span className="text-slate-700 font-medium ml-auto tabular-nums">{formatDateTime(selectedRequest.processedAt)}</span>
                    </div>
                  )}
                  {selectedRequest.processedBy && (
                    <div className="flex items-center gap-3 text-[13px]">
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
                  <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Requester's Reason</h4>
                  <p className="text-[13px] text-slate-600 p-3 rounded-xl bg-slate-50 border border-slate-100 italic">{selectedRequest.remarks}</p>
                </div>
              )}

              {/* Admin remarks (processed) */}
              {selectedRequest.adminRemarks && (
                <div>
                  <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Admin Notes</h4>
                  <p className="text-[13px] text-slate-600 p-3 rounded-xl bg-slate-50 border border-slate-100">{selectedRequest.adminRemarks}</p>
                </div>
              )}

              {/* Admin response textarea */}
              {(canApprove || canReject) && selectedRequest.status === 'PENDING' && (
                <div>
                  <h4 className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Your Response <span className="text-red-500">*</span></h4>
                  <textarea
                    value={adminRemarks}
                    onChange={e => setAdminRemarks(e.target.value)}
                    placeholder="Enter notes about your decision (required)..."
                    rows={3}
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-[13px] text-slate-700 resize-none focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500 bg-white"
                  />
                </div>
              )}
            </div>

            {/* Footer actions */}
            {(canApprove || canReject) && selectedRequest.status === 'PENDING' && (
              <div className="px-6 py-4 border-t border-slate-100 bg-white flex items-center gap-3">
                {canReject && (
                  <button onClick={() => handleProcess('reject')} disabled={processing}
                    className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50 shadow-sm">
                    {processing ? 'Processing...' : 'Reject'}
                  </button>
                )}
                {canApprove && (
                  <button onClick={() => handleProcess('approve')} disabled={processing}
                    className="flex-1 px-4 py-2.5 rounded-xl text-[13px] font-semibold text-white bg-emerald-600 hover:bg-emerald-700 transition-colors disabled:opacity-50 shadow-sm">
                    {processing ? 'Processing...' : 'Approve'}
                  </button>
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
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md overflow-hidden focus:outline-none"
            >
              <div className="px-6 py-5 bg-gradient-to-br from-emerald-500 to-teal-600 text-white">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-white/20 flex items-center justify-center">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-lg font-bold">Request Approved</h3>
                    <p className="text-[12px] text-white/80">{approvalResult.message ?? 'Action completed successfully.'}</p>
                  </div>
                </div>
              </div>
              <div className="p-6 space-y-4">
                {approvalResult.temporaryPassword && (
                  <div className="rounded-lg bg-amber-50 border border-amber-200 p-3 text-[12px] text-amber-800">
                    <strong>Share these credentials with the user.</strong> They won't be shown again. The user must change the password on first login.
                  </div>
                )}
                {approvalResult.username && (
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Username</label>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="flex-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[13px] text-slate-800 font-mono">{approvalResult.username}</code>
                      <button
                        onClick={() => copyToClipboard(approvalResult.username!, 'username')}
                        // Both copy buttons render the bare word "Copy" — without
                        // a label they are indistinguishable out of visual context.
                        aria-label="Copy username"
                        className="px-3 py-2.5 rounded-lg text-[12px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                      >
                        {copied === 'username' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
                {approvalResult.temporaryPassword && (
                  <div>
                    <label className="text-[11px] font-bold text-slate-400 uppercase tracking-wider">Temporary Password</label>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="flex-1 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-lg text-[13px] text-slate-800 font-mono">{approvalResult.temporaryPassword}</code>
                      <button
                        onClick={() => copyToClipboard(approvalResult.temporaryPassword!, 'password')}
                        aria-label="Copy temporary password"
                        className="px-3 py-2.5 rounded-lg text-[12px] font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                      >
                        {copied === 'password' ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-slate-100 flex justify-end">
                <button
                  onClick={() => { setApprovalResult(null); setCopied(''); }}
                  className="px-5 py-2 rounded-lg text-[13px] font-semibold text-white bg-cyan-600 hover:bg-cyan-700 transition-colors"
                >
                  Done
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
