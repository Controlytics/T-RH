import { useState } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { ConnectionInstructions } from './connection-instructions';

/**
 * The one-time credential dialog.
 *
 * The token is stored hashed, so this is the only moment it can be shown. That
 * makes the copy affordance and the "shown once" warning load-bearing UI, not
 * decoration — an operator who dismisses this without copying has to regenerate,
 * which revokes the credential the device may already have been given.
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

  return (
    <Dialog open={open} onClose={() => { /* deliberately not dismissible by backdrop */ }} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4 px-6 py-4">
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3">
          <p className="text-sm font-semibold text-amber-900">
            This is the only time this token will be shown.
          </p>
          <p className="mt-1 text-xs text-amber-800">
            It is stored hashed and cannot be retrieved. If it is lost you must
            regenerate it, which immediately stops the old one from working.
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
          <ConnectionInstructions code={code} token={token} />
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
