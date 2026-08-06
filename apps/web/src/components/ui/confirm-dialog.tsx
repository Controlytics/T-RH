import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';

/**
 * The app-wide "are you sure?" for a destructive action.
 *
 * Extracted 2026-08-06 from six hand-rolled or `window.confirm` call sites.
 * `window.confirm` was the original pattern in five of them and is wrong here
 * twice over: it is unstyled OS chrome in an app where every other confirmation
 * is a themed dialog, and it blocks the JS thread, so nothing else on the page
 * can react while it is open.
 *
 * Shape follows `audit-delete-dialog` (red warning header, consequence in a red
 * panel, Cancel + a red confirm) — that was the most careful of the existing
 * dialogs and there is no reason for a second convention.
 *
 * `warning` is OPTIONAL on purpose. Some deletes genuinely have a consequence
 * worth spelling out ("the value is kept in the audit trail, but not on the
 * instrument"); others are ordinary config rows, and inventing red copy for
 * those would train operators to skip the panel where it matters.
 */
export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  /** The question. A node, so a call site can emphasise the subject's name. */
  message: ReactNode;
  /** Consequence text for the red panel. Omit when there isn't a real one. */
  warning?: ReactNode;
  /** Confirm button label — name the act ("Delete rule"), never "OK". */
  confirmLabel: string;
  /** Shown on the confirm button while the request is in flight. */
  busyLabel?: string;
  /**
   * Request in flight. Disables both buttons AND backdrop/Esc dismissal: a
   * dialog that can be dismissed mid-request hides an action the operator can
   * no longer see the outcome of.
   */
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmDialog({
  open, title, message, warning, confirmLabel, busyLabel, busy = false, onConfirm, onClose,
}: ConfirmDialogProps) {
  return (
    // Backdrop/Esc (Dialog's `onClose`) is the CANCEL path — the safe one. The
    // destructive act always needs the explicit button.
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} className="max-w-md">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-red-100 text-red-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          </div>
          {title}
        </DialogTitle>
      </DialogHeader>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">{message}</p>
        {warning && (
          <div className="p-3 rounded-lg bg-red-50 border border-red-100">
            <p className="text-xs text-red-700 font-medium">{warning}</p>
          </div>
        )}
        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button" size="sm" disabled={busy}
            className="bg-red-600 hover:bg-red-700 text-white"
            onClick={onConfirm}
          >
            {busy ? (busyLabel ?? 'Working…') : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
