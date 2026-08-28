import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import type { PasswordPolicyConfig } from '@digilog/shared';

interface UnlockDialogData {
  userId: string;
  username: string;
  /** Credential lives in Active Directory — no temporary password is issued. */
  isDirectory: boolean;
}

interface UserUnlockDialogProps {
  unlockDialog: UnlockDialogData | null;
  unlockPassword: string;
  showUnlockPassword: boolean;
  unlockCopied: boolean;
  onClose: () => void;
  onToggleShowPassword: () => void;
  onCopy: () => void;
  onRegenerate: () => void;
  onConfirm: () => void;
  policy: PasswordPolicyConfig;
}

export function UserUnlockDialog({
  unlockDialog,
  unlockPassword,
  showUnlockPassword,
  unlockCopied,
  onClose,
  onToggleShowPassword,
  onCopy,
  onRegenerate,
  onConfirm,
}: UserUnlockDialogProps) {
  return (
    <Dialog open={!!unlockDialog} onClose={onClose}>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-emerald-100">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
            </svg>
          </div>
          Unlock Account
        </DialogTitle>
      </DialogHeader>
      <div className="py-4 space-y-4">
        {/* Directory accounts: unlocking clears this application's lock and
            nothing else — there is no password to generate, copy, or hand over.
            Rendering the temporary-password block for them would show an empty
            field and instruct the admin to share a password that was never set. */}
        {unlockDialog?.isDirectory ? (
          <>
            <p className="text-slate-600">
              Unlock user <strong className="text-slate-800">@{unlockDialog.username}</strong>.
              They sign in with their Active Directory account, so no temporary password is issued.
            </p>
            <div className="flex items-start gap-3 p-4 rounded-xl bg-sky-50 border border-sky-200">
              <svg className="w-5 h-5 text-sky-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-sky-700">
                This clears the lock in this application only. If the account is also locked or
                disabled in Active Directory, your IT team must clear it there as well.
              </p>
            </div>
          </>
        ) : (
        <>
        <p className="text-slate-600">
          Unlock user <strong className="text-slate-800">@{unlockDialog?.username}</strong> with a temporary password. The user must change their password on next login.
        </p>

        <div className="space-y-3">
          <label className="block text-sm font-semibold text-slate-700">Temporary Password</label>
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <input
                type={showUnlockPassword ? 'text' : 'password'}
                value={unlockPassword}
                readOnly
                className="ctl w-full font-mono"
              />
              <button
                type="button"
                onClick={onToggleShowPassword}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              >
                {showUnlockPassword ? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                  </svg>
                ) : (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                )}
              </button>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={onCopy}
              className={`gap-1.5 shrink-0 ${unlockCopied ? 'border-emerald-300 text-emerald-600' : ''}`}
            >
              {unlockCopied ? (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                  Copied
                </>
              ) : (
                <>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                  Copy
                </>
              )}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={onRegenerate}
              className="gap-1.5 shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
              Regenerate
            </Button>
          </div>
        </div>

        <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
          <svg className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-sm text-amber-700">
            Please copy and share this temporary password with the user securely. They will be required to set a new password upon login.
          </p>
        </div>
        </>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button
          className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600"
          onClick={onConfirm}
        >
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 11V7a4 4 0 118 0m-4 8v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2z" />
          </svg>
          Unlock Account
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
