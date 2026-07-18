import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { useToast } from '@/hooks/use-toast';
import { submitForReview } from '@/lib/report-review';
import type { ReportSnapshot } from '@/lib/pdf-report';

interface Role { name: string; displayName: string; }
interface User { id: string; username: string; role?: string; fullName?: string; }

/**
 * "Send for Review" — captures the current report as a snapshot and sends it to
 * a user OR a role for the review/approval workflow. Drop it next to a report's
 * ExportMenu; pass a buildSnapshot() that builds the report and returns
 * report.getSnapshot().
 */
// 2026-06-22: "Send for Review" is HIDDEN across all report pages per request.
// The component renders nothing, which also fixes Export-menu placement on pages
// where it was a bare sibling in a `justify-between` header (the null child drops
// out of the flex row, so the Export button lands on the right instead of being
// stranded in the middle). The review-workflow UI below is retained for easy
// re-enable — flip this flag back to true.
const SEND_FOR_REVIEW_ENABLED = false;

export function SendForReviewButton({ buildSnapshot, className }: {
  buildSnapshot: () => Promise<ReportSnapshot | null> | ReportSnapshot | null;
  className?: string;
}) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [snapshot, setSnapshot] = useState<ReportSnapshot | null>(null);
  const [mode, setMode] = useState<'role' | 'user'>('role');
  const [role, setRole] = useState('');
  const [userId, setUserId] = useState('');
  const [busy, setBusy] = useState(false);

  const { data: rolesData } = useSWR<Role[]>(open ? '/api/roles/active' : null);
  const { data: usersData } = useSWR<any>(open ? '/api/users?limit=500' : null);
  const roles = useMemo(() => (rolesData ?? []).filter((r) => r.name !== 'SUPER_ADMIN'), [rolesData]);
  const users: User[] = useMemo(() => {
    const raw = Array.isArray(usersData) ? usersData : (usersData?.data ?? usersData?.users ?? []);
    return (raw as User[]).filter((u) => u.username);
  }, [usersData]);

  const start = async () => {
    try {
      const snap = await buildSnapshot();
      if (!snap || !snap.sections?.length) { toast.error('Nothing to send', 'There is no report data to send for review.'); return; }
      setSnapshot(snap); setRole(''); setUserId(''); setMode('role'); setOpen(true);
    } catch (e: any) { toast.error('Failed', e?.message ?? 'Could not prepare the report.'); }
  };

  const send = async () => {
    if (!snapshot) return;
    if (mode === 'role' && !role) { toast.error('Pick a role', 'Choose a role to send this to.'); return; }
    if (mode === 'user' && !userId) { toast.error('Pick a user', 'Choose a user to send this to.'); return; }
    setBusy(true);
    try {
      await submitForReview(snapshot, mode === 'role' ? { role } : { userId });
      toast.success('Sent for review', 'The report is now awaiting review.');
      setOpen(false);
    } catch (e: any) {
      toast.error('Failed', e?.message ?? 'Could not send for review.');
    } finally { setBusy(false); }
  };

  // Hidden per request (see SEND_FOR_REVIEW_ENABLED note above). Placed after all
  // hooks so hook order stays consistent (Rules of Hooks).
  if (!SEND_FOR_REVIEW_ENABLED) return null;

  return (
    <>
      <button onClick={start} className={className ?? 'flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 hover:bg-slate-50 hover:border-slate-300 transition-colors'}>
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" /></svg>
        Send for Review
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => !busy && setOpen(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="px-6 py-4 rounded-t-2xl text-white" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
              <h3 className="font-bold">Send report for review</h3>
              <p className="text-white/80 text-[12px] mt-0.5">{snapshot?.title}</p>
            </div>
            <div className="p-6 space-y-4">
              <div className="flex items-center gap-2">
                <button onClick={() => setMode('role')} className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold ${mode === 'role' ? 'text-white bg-cyan-600' : 'text-slate-600 bg-slate-100'}`}>To a role</button>
                <button onClick={() => setMode('user')} className={`px-3 py-1.5 rounded-lg text-[12px] font-semibold ${mode === 'user' ? 'text-white bg-cyan-600' : 'text-slate-600 bg-slate-100'}`}>To a user</button>
              </div>
              {mode === 'role' ? (
                <select value={role} onChange={(e) => setRole(e.target.value)} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500/30">
                  <option value="">Select a role…</option>
                  {roles.map((r) => <option key={r.name} value={r.name}>{r.displayName || r.name}</option>)}
                </select>
              ) : (
                <select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-cyan-500/30">
                  <option value="">Select a user…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.username}{u.role ? ` (${u.role})` : ''}</option>)}
                </select>
              )}
            </div>
            <div className="px-6 py-4 bg-slate-50 rounded-b-2xl flex justify-end gap-2">
              <button onClick={() => setOpen(false)} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-slate-600 hover:bg-slate-100">Cancel</button>
              <button onClick={send} disabled={busy} className="px-4 py-2 rounded-lg text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 disabled:opacity-50">{busy ? 'Sending…' : 'Send'}</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
