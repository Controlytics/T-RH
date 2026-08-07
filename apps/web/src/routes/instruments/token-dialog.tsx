import { useState } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { ConnectionInstructions } from './connection-instructions';

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
  open, title, id, code, token, onClose,
}: {
  open: boolean;
  title: string;
  /** The instrument's UUID — what the connection example must use on the wire. */
  id: string;
  code: string;
  token: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

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

        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-800">How this instrument connects</h4>
          <ConnectionInstructions id={id} code={code} token={token} />
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
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
