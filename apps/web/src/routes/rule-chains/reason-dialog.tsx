import { useEffect, useState, type ReactNode } from 'react';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { Button } from '@/components/ui/button';
import { reauthActionLabel, useReauth } from '@/hooks/use-reauth';
import { RULE_CHAIN_REASON_MAX, RULE_CHAIN_REAUTH_ACTION } from './types';

/**
 * The REASON every rule chain write is signed with (rule chains, 2026-11-04;
 * spec section 12): create, save, import, make root, delete and debug clear.
 * The server refuses a blank one (400 REASON_REQUIRED) and stores it on the
 * audit row, so the dialog says so. It stays open while the write runs and
 * shows a refusal in place; the caller closes it on success.
 */
export function ReasonDialog({
  open, title, subtitle, confirmLabel, busyLabel = 'Saving…', busy, error, danger = false, canConfirm = true, children, onConfirm, onClose,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  confirmLabel: string;
  busyLabel?: string;
  busy: boolean;
  error?: string | null;
  danger?: boolean;
  /** False while a field the caller added (a name, a file) is not ready. */
  canConfirm?: boolean;
  /** The caller's own fields and words, above the reason. */
  children?: ReactNode;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  // Cleared on every open: a reason left from the previous act would be signed against a different one.
  useEffect(() => { if (open) setReason(''); }, [open]);
  const blank = reason.trim() === '';

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} className="max-w-lg">
      <DialogBanner title={title} subtitle={subtitle} tone={danger ? 'danger' : 'theme'} />
      <div className="space-y-4">
        {children}
        <label className="block space-y-1">
          <span className="text-sm font-semibold text-slate-700">Reason</span>
          <textarea
            aria-label="Reason"
            rows={3}
            value={reason}
            maxLength={RULE_CHAIN_REASON_MAX}
            disabled={busy}
            onChange={(e) => setReason(e.target.value)}
            className="ctl w-full"
            placeholder="Why is this change being made?"
          />
          <span className="block text-xs text-slate-500">Required. Recorded in the audit trail against your user.</span>
        </label>
        {error && (
          <p role="alert" className="rounded-[var(--radius-control)] border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button
          type="button"
          variant={danger ? 'destructive' : 'default'}
          disabled={blank || !canConfirm}
          loading={busy}
          loadingText={busyLabel}
          onClick={() => onConfirm(reason.trim())}
        >
          {confirmLabel}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}

/** The server's words for a refusal, else a fallback. */
export function refusalText(e: unknown, fallback = 'Please try again.'): string {
  return (e as { message?: string } | null)?.message || fallback;
}

/**
 * ONE runner for every rule chain write on a page: the re-auth action, the
 * busy flag cleared by the three outcomes only (never after the `await`, which
 * returns as soon as the password dialog opens), and the refusal text. The
 * page renders `reauth` in a `ReauthDialog`.
 */
export function useChainWrites() {
  const reauth = useReauth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = (
    call: (password?: string) => Promise<unknown>,
    handlers: {
      done: (result: unknown) => void | Promise<void>;
      /** Return true when the page has shown the refusal itself (a 409 dialog). */
      refused?: (e: unknown) => boolean;
    },
  ) => {
    setBusy(true);
    setError(null);
    void reauth.execute(RULE_CHAIN_REAUTH_ACTION, async (password?: string) => {
      const result = await call(password);
      await handlers.done(result);
    }, {
      onSuccess: () => setBusy(false),
      onError: (e: unknown) => {
        setBusy(false);
        if (!handlers.refused?.(e)) setError(refusalText(e));
      },
      onCancel: () => setBusy(false),
    });
  };

  return { reauth, busy, error, setError, run, actionLabel: reauthActionLabel(RULE_CHAIN_REAUTH_ACTION) };
}
