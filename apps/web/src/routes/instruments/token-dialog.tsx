import { useState } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { ConnectionInstructions } from './connection-instructions';
import { useAuth } from '@/hooks/use-auth';

/**
 * The just-issued credential dialog.
 *
 * It used to say the token could never be shown again — true until 2026-08-06,
 * when spec D5 was reversed and `GET /:id/token` gained the ability to reveal
 * it (encrypted at rest, INSTRUMENT_UPDATE, always-on password, one audit row
 * per view). Leaving the old warning here would have taught operators to treat
 * a lost token as unrecoverable and regenerate — needlessly killing a working
 * field device — so the text now says what is actually true.
 *
 * The copy affordance stays load-bearing: copying now is still free, whereas
 * getting it back later costs a password and leaves a record.
 */
export function TokenDialog({
  open, title, code, token, onClose,
}: {
  open: boolean;
  title: string;
  code: string;
  token: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  return (
    <Dialog open={open} onClose={() => { /* deliberately not dismissible by backdrop */ }} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4 px-6 py-4">
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">
            Copy this token now.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            It can be revealed again later from this instrument&apos;s Access
            token panel, but that needs your password and is recorded in the
            audit trail against your user.
          </p>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <span className="text-sm font-medium text-slate-700">Access token for {code}</span>
            <Button
              type="button" size="sm" variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(token);
                setCopied(true);
                setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
              }}
            >
              {copied ? 'Copied' : 'Copy token'}
            </Button>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-slate-300 bg-slate-900 p-3 text-xs text-emerald-300 break-all whitespace-pre-wrap">
            {token}
          </pre>
        </div>

        {/* SUPER_ADMIN only, matching the Connection card on the instrument
            page (2026-08-19). Gated here too rather than only there: this dialog
            opens from creation AND from regenerating a token, so leaving it
            ungated would show the wiring runbook to exactly the roles the card
            hides it from. The token above is NOT gated with it — whoever just
            issued it has to be able to copy it. */}
        {isSuperAdmin && (
          <div>
            <h4 className="mb-2 text-sm font-semibold text-slate-800">How this instrument connects</h4>
            <ConnectionInstructions code={code} token={token} />
          </div>
        )}

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="ctl-check mt-0.5"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          <span>I have copied the token and stored it securely.</span>
        </label>
      </div>

      <DialogFooter>
        {/* Gated on the acknowledgement rather than closable outright: closing
            is irreversible for this value, so it should take a deliberate act. */}
        <Button onClick={onClose} disabled={!acknowledged}>Done</Button>
      </DialogFooter>
    </Dialog>
  );
}
