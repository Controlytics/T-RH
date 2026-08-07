import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

/**
 * The instrument's access token, as ONE ROW.
 *
 * Rebuilt 2026-08-07 (operator request): the panel was a stack of buttons and
 * paragraphs taking a full card for a single value. It is now a masked field
 * with an eye toggle, which is what a credential field looks like everywhere
 * else, and reads at a glance.
 *
 * ── The eye is not free, and that is not a UI choice ──
 * The FIRST unmasking calls `GET /:id/token`, which enforces `enforceReauthAlways`
 * server-side: it asks for the operator's password and writes an
 * `INSTRUMENT_TOKEN_VIEWED` audit row. That is the control that makes a
 * retrievable credential acceptable at all (spec §3.1), so the password prompt
 * cannot be designed away here — only the button around it can change. Once the
 * value is in hand, the eye toggles the mask locally with no further round trip
 * and no further audit row: the view was already recorded.
 *
 * ── The revealed value is deliberately NOT owned here ──
 * It lives in the parent route's `useState`. The revealed token has to reach the
 * connection panel (its command is useless with a placeholder in it), and route
 * state unmounts on navigation — which is exactly the required re-hide. It must
 * never go in SWR: an SWR key survives unmount, so returning to the page would
 * redisplay a live credential with no re-auth, on a shared workstation.
 */

/**
 * The server's rule, from `setInstrumentTokenSchema` in @digilog/shared.
 *
 * There is no maximum and no strength floor — the 32–128 bounds were removed
 * 2026-08-06 so a credential fixed in a device's firmware can be entered as it
 * is. The one remaining length rule is not about strength: the first
 * `TOKEN_PREFIX_LEN` characters are stored as a NON-SECRET prefix and shown to
 * anyone who can view this instrument, so a token that short would be fully
 * disclosed on this very page without a password or an audit row.
 */
const TOKEN_PREFIX_LEN = 8;
const TOKEN_RULE = `Any length over ${TOKEN_PREFIX_LEN} characters. Letters, digits, dot, dash and underscore only.`;
const TOKEN_PREFIX_NOTE = `The first ${TOKEN_PREFIX_LEN} characters are shown as a non-secret prefix to anyone who can view this instrument, so a shorter token would be fully visible without a password.`;
const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface TokenPanelProps {
  code: string;
  /** First 8 characters of the live token, or null if there is no credential. */
  tokenPrefix: string | null;
  /**
   * From the instrument detail response. False for a credential issued before
   * the encryption landed, or when no INSTRUMENT_TOKEN_KEY is configured — in
   * both cases unmasking can only produce an error, so the eye is not offered.
   */
  tokenRevealable: boolean;
  canEdit: boolean;
  /** The revealed value, owned by the route. Null while not yet fetched. */
  token: string | null;
  onHide: () => void;
  onReveal: () => Promise<void> | void;
  onSetToken: (token: string) => Promise<void>;
  onRegenerate: () => Promise<void> | void;
}

function EyeIcon({ open }: { open: boolean }) {
  return (
    <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      {open ? (
        <>
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
        </>
      ) : (
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
      )}
    </svg>
  );
}

export function TokenPanel({
  code, tokenPrefix, tokenRevealable, canEdit,
  token, onHide, onReveal, onSetToken, onRegenerate,
}: TokenPanelProps) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [settingOpen, setSettingOpen] = useState(false);
  const [draft, setDraft] = useState('');

  // Mirror of the shared Zod rule, checked before the request so the operator
  // sees the constraint as they type rather than as a 400 after a password
  // prompt. The server still validates — this is a courtesy, not the gate.
  const draftError = !draft
    ? ''
    : draft.length <= TOKEN_PREFIX_LEN
      ? `Too short — more than ${TOKEN_PREFIX_LEN} characters, or the whole token shows in the prefix.`
    : !TOKEN_PATTERN.test(draft) ? 'Only letters, digits, dot, dash and underscore.'
    : '';

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const submitToken = async () => {
    if (draftError || !draft) return;
    await run(async () => {
      await onSetToken(draft);
      setDraft('');
      setSettingOpen(false);
    });
  };

  const shown = Boolean(token);
  // Masked form keeps the non-secret prefix visible: it is what an operator
  // matches against a device's config sheet without spending a password.
  const masked = tokenPrefix ? `${tokenPrefix}${'•'.repeat(24)}` : '—';

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-800" title={shown ? token! : undefined}>
          {shown ? token : masked}
        </code>

        {canEdit && tokenRevealable && (
          <button
            type="button"
            disabled={busy}
            onClick={() => (shown ? onHide() : void run(onReveal))}
            aria-label={shown ? 'Hide token' : 'Show token'}
            title={shown ? 'Hide token' : 'Show token — asks for your password and is recorded in the audit trail'}
            className="rounded-lg border border-slate-200 bg-white p-1.5 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-700 disabled:opacity-50"
          >
            <EyeIcon open={shown} />
          </button>
        )}

        {shown && (
          <Button
            type="button" size="sm" variant="secondary"
            onClick={() => {
              void navigator.clipboard?.writeText(token!);
              setCopied(true);
              setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        )}

        {canEdit && !settingOpen && (
          <Button type="button" size="sm" variant="secondary" onClick={() => setSettingOpen(true)}>
            Set token
          </Button>
        )}
      </div>

      {/* One line, and it stays. The panel was compacted at the operator's
          request, but this disclosure is the control the reveal was granted on
          (spec §3.1) — an operator asked to accept an attributable view has to
          be able to SEE that it is attributable, so it cannot retreat into the
          button's tooltip. */}
      {canEdit && tokenRevealable && (
        <p className="text-xs text-slate-500">
          {shown
            ? 'This view was recorded in the audit trail against your user. The token hides again when you leave this page.'
            : 'Showing the token asks for your password and records the view in the audit trail.'}
        </p>
      )}

      {canEdit && !tokenRevealable && (
        // Not revealable: the credential predates the encryption, or the server
        // has no INSTRUMENT_TOKEN_KEY. An eye here would spend the operator's
        // password to reach an error, so the action that resolves it is offered
        // instead.
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <p className="text-xs text-slate-600">
            This token cannot be shown — it was issued before tokens were stored
            recoverably, or the server has no token encryption key. Regenerating
            issues one that can be shown; the device stops working until it is
            reconfigured.
          </p>
          <Button
            type="button" size="sm" variant="secondary" className="mt-2"
            disabled={busy} onClick={() => void run(onRegenerate)}
          >
            Regenerate token
          </Button>
        </div>
      )}

      {!canEdit && (
        <p className="text-xs text-slate-500">
          You do not have permission to view or change this instrument&apos;s token.
        </p>
      )}

      {canEdit && settingOpen && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <div>
            <span className="text-sm font-medium text-slate-700">Set a specific token</span>
            {/* The rules are stated BEFORE the field: the value is usually
                copied off a device's config sheet, and finding out afterwards
                that it is unusable means going back to the device. */}
            <p className="mt-0.5 text-xs text-slate-500">{TOKEN_RULE}</p>
            <p className="mt-0.5 text-xs text-slate-500">{TOKEN_PREFIX_NOTE}</p>
          </div>
          <Input
            value={draft}
            autoComplete="off"
            spellCheck={false}
            placeholder="e.g. a device credential fixed in firmware"
            onChange={(e) => setDraft(e.target.value)}
          />
          {draftError && <p className="text-xs text-red-600">{draftError}</p>}
          <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2">
            <p className="text-xs text-amber-900">
              The current token is revoked the moment this is saved.{' '}
              <strong>{code} stops sending data</strong> until the device is
              reconfigured with the new value. Your password is required.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" disabled={busy || !draft || !!draftError} onClick={() => void submitToken()}>
              {busy ? 'Saving…' : 'Save token'}
            </Button>
            <Button
              type="button" size="sm" variant="secondary" disabled={busy}
              onClick={() => { setDraft(''); setSettingOpen(false); }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
