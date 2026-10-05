import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { USER_ACTION_REASON_MAX } from './user-action-dialog';

interface UserBulkDeleteDialogProps {
  open: boolean;
  selectedIds: Set<string>;
  displayedUsers: any[];
  bulkDeleting: boolean;
  onClose: () => void;
  /**
   * Called with the operator's REASON (audit 2026-10-03, DATA-11): the server
   * refuses a bulk delete without one and stores it on every
   * BULK_USER_DELETED row.
   */
  onConfirm: (reason: string) => void;
}

export function UserBulkDeleteDialog({
  open,
  selectedIds,
  displayedUsers,
  bulkDeleting,
  onClose,
  onConfirm,
}: UserBulkDeleteDialogProps) {
  const [reason, setReason] = useState('');
  useEffect(() => { if (open) setReason(''); }, [open]);
  const reasonMissing = reason.trim().length === 0;

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-red-100">
            <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          Delete {selectedIds.size} User{selectedIds.size !== 1 ? 's' : ''}
        </DialogTitle>
      </DialogHeader>
      <div className="py-4">
        <p className="text-slate-600">
          Are you sure you want to delete the following users?
        </p>
        <div className="mt-3 max-h-48 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
          {displayedUsers
            .filter((u: any) => selectedIds.has(u.id))
            .map((u: any) => (
              <div key={u.id} className="flex items-center gap-3 px-4 py-2">
                <div className="w-8 h-8 rounded-lg bg-[var(--theme-primary,#2a78d6)] flex items-center justify-center text-white text-xs font-semibold">
                  {u.fullName.split(' ').map((n: string) => n[0]).join('').toUpperCase().slice(0, 2)}
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-800">{u.fullName}</p>
                  <p className="text-xs text-slate-500">@{u.username}</p>
                </div>
              </div>
            ))}
        </div>
        <div className="mt-4 flex items-start gap-3 p-4 rounded-xl bg-red-50 border border-red-200">
          <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="text-sm text-red-700">
            {/* Mirrors the single-delete copy: userRepository.deleteMany runs
                tx.user.deleteMany — the rows are destroyed, not disabled. */}
            <p className="font-semibold">Warning: This permanently deletes these accounts!</p>
            <p className="mt-1">Every selected user record is erased from the database — along with their sessions, password history, personal settings and assignments. This is a deletion, not a disable, and it cannot be undone.</p>
            <p className="mt-1">Only the audit trail entries survive, recording each username, full name, role and status at the time of deletion.</p>
          </div>
        </div>
        <label className="mt-4 block space-y-1">
          <span className="text-sm font-medium text-slate-700">Reason</span>
          <textarea
            rows={3}
            value={reason}
            maxLength={USER_ACTION_REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            className="ctl w-full"
            placeholder="Why are these accounts being deleted?"
            aria-label="Reason"
          />
          <span className="block text-xs text-slate-500">
            Required. Recorded in the audit trail against your user, on every account.
          </span>
        </label>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          variant="destructive"
          onClick={() => onConfirm(reason.trim())}
          disabled={reasonMissing}
          loading={bulkDeleting}
          loadingText="Deleting…"
        >
          {`Delete ${selectedIds.size} User${selectedIds.size !== 1 ? 's' : ''}`}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
