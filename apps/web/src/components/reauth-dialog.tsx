import { useEffect } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SignaturePasswordInput } from '@/components/ui/signature-password-input';

interface ReauthDialogProps {
  open: boolean;
  password: string;
  error: string;
  isVerifying: boolean;
  onPasswordChange: (password: string) => void;
  onConfirm: () => void;
  onCancel: () => void;
  actionLabel?: string;
}

export function ReauthDialog({
  open,
  password,
  error,
  isVerifying,
  onPasswordChange,
  onConfirm,
  onCancel,
  actionLabel,
}: ReauthDialogProps) {
  // The autofill guard, the type switch, the reveal toggle and the initial focus
  // all belong to SignaturePasswordInput. What stays here is the close behaviour:
  // leaving focus inside a dialog that has just unmounted strands the caret on a
  // detached node, and the next dialog opens with nothing focused.
  useEffect(() => {
    if (!open && document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }, [open]);

  return (
    <Dialog open={open} onClose={onCancel} priority>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-100">
            <svg
              className="w-5 h-5 text-blue-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
              />
            </svg>
          </div>
          Confirm Your Identity
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {actionLabel
            ? `Performing "${actionLabel}" requires identity verification.`
            : 'This action requires identity verification.'}{' '}
          Please enter your current password to continue.
        </p>
        {error && (
          <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div className="space-y-2">
          <label className="text-sm font-medium text-slate-700">Current Password</label>
          {/* The four anti-autofill measures live in ONE place now
              (`SignaturePasswordInput`). They were written here first and then
              omitted from the Alarms acknowledge dialog, which shipped a
              browser-fillable §11 signature — a second copy is how that happens
              again. */}
          <SignaturePasswordInput
            value={password}
            onChange={onPasswordChange}
            onEnter={onConfirm}
            placeholder="Enter your password"
            autoFocus={open}
          />
        </div>
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={(e) => { e.preventDefault(); e.stopPropagation(); onCancel(); }}>
          Cancel
        </Button>
        <Button
          onClick={onConfirm}
          disabled={!password || isVerifying}
          className="bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 text-white"
        >
          {isVerifying ? 'Verifying...' : 'Verify & Continue'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
