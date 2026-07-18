import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { RoleData } from '@digilog/shared';

interface RoleDeleteDialogProps {
  open: boolean;
  role: RoleData | null;
  error: string;
  deleting: boolean;
  onClose: () => void;
  onDelete: () => void;
}

export function RoleDeleteDialog({
  open,
  role,
  error,
  deleting,
  onClose,
  onDelete,
}: RoleDeleteDialogProps) {
  return (
    <Dialog open={open} onClose={onClose} className="max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-red-100 text-red-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
            </svg>
          </div>
          Delete Role
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        {error && (
          <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
            <div className="p-2 rounded-lg bg-red-100">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        <p className="text-slate-600">
          Are you sure you want to permanently delete the role{' '}
          <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold text-white ${role?.color}`}>
            {role?.displayName}
          </span>
          ?
        </p>
        <p className="text-sm text-slate-500">
          This action cannot be undone. The role will be permanently removed from the system.
        </p>

        <div className="flex items-center justify-end gap-3 pt-4 border-t border-slate-100">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={onDelete}
            disabled={deleting}
            className="bg-red-600 hover:bg-red-700 text-white"
          >
            {deleting ? 'Deleting...' : 'Delete Role'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
