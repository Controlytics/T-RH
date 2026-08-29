import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

interface ActionDialogData {
  type: string;
  userId: string;
  username: string;
  fullName?: string;
}

interface UserActionDialogProps {
  actionDialog: ActionDialogData | null;
  onClose: () => void;
  onConfirm: () => void;
}

export function UserActionDialog({ actionDialog, onClose, onConfirm }: UserActionDialogProps) {
  return (
    <Dialog open={!!actionDialog} onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${
            actionDialog?.type === 'delete' ? 'bg-red-100' :
            actionDialog?.type === 'disable' ? 'bg-red-100' : 'bg-emerald-100'
          }`}>
            <svg className={`w-5 h-5 ${
              actionDialog?.type === 'delete' ? 'text-red-600' :
              actionDialog?.type === 'disable' ? 'text-red-600' : 'text-emerald-600'
            }`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              {actionDialog?.type === 'enable' && (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              )}
              {actionDialog?.type === 'disable' && (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
              )}
              {actionDialog?.type === 'delete' && (
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              )}
            </svg>
          </div>
          {actionDialog?.type === 'enable' ? 'Enable' :
           actionDialog?.type === 'delete' ? 'Delete' : 'Disable'} User
        </DialogTitle>
      </DialogHeader>
      <div className="py-4">
        <p className="text-slate-600">
          Are you sure you want to {actionDialog?.type} user <strong className="text-slate-800">{actionDialog?.fullName || actionDialog?.username}</strong>?
        </p>
        {actionDialog?.type === 'disable' && (
          <div className="mt-4 flex items-start gap-3 p-4 rounded-xl bg-red-50 border border-red-200">
            <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <p className="text-sm text-red-700">
              This will terminate all active sessions for this user. They will not be able to log in until re-enabled.
            </p>
          </div>
        )}
        {actionDialog?.type === 'delete' && (
          <div className="mt-4 flex items-start gap-3 p-4 rounded-xl bg-red-50 border border-red-200">
            <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-sm text-red-700">
              {/* Says what user.repository.delete() actually does: tx.user.delete —
                  a physical row delete (authorized design), cascading to sessions,
                  password history and assignments, plus an explicit userConfig
                  wipe. The previous copy promised "disabled" and "data retained",
                  i.e. the opposite in both directions — misleading consent on an
                  irreversible §11 action. Fix the copy, not the behaviour. */}
              <p className="font-semibold">Warning: This permanently deletes the account!</p>
              <p className="mt-1">The user record is erased from the database — along with their sessions, password history, personal settings and assignments. This is a deletion, not a disable, and it cannot be undone.</p>
              <p className="mt-1">Only the audit trail entry survives, recording the username, full name, email, role and status at the time of deletion. To keep the account and merely block access, use Disable instead.</p>
            </div>
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          variant={(actionDialog?.type === 'disable' || actionDialog?.type === 'delete') ? 'destructive' : 'success'}
          onClick={onConfirm}
        >
          {actionDialog?.type === 'enable' && (
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {actionDialog?.type === 'disable' && (
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          )}
          {actionDialog?.type === 'delete' && (
            <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          )}
          {actionDialog?.type === 'delete' ? 'Delete User' : 'Confirm'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
