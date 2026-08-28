import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

/**
 * The instrument's access token, as ONE ROW: show it, copy it, edit it.
 *
 * Rebuilt twice. 2026-08-07 removed the separate "Set a specific token" panel —
 * a second field, its own rules and its own warning block, sitting under a row
 * that already showed the token. There is one token; there is now one control
 * for it. Editing is IN PLACE on the value you are looking at.
 *
 * ── Editing requires showing first, and that is not a UI choice ──
 * You cannot edit a mask. Revealing calls `GET /:id/token`, which enforces
 * `enforceReauthAlways`: it asks for the operator's password and writes an
 * `INSTRUMENT_TOKEN_VIEWED` audit row. That is the control that makes a
 * retrievable credential acceptable at all (spec §3.1). Saving a new value then
 * asks again — `PUT /:id/token` is also `enforceReauthAlways`. Neither prompt
 * can be designed away here; only the buttons around them can change.
 *
 * ── The revealed value is deliberately NOT owned here ──
 * It lives in the parent route's `useState`. It has to reach the connection
 * panel (whose command is useless with a placeholder in it), and route state
 * unmounts on navigation — which is exactly the required re-hide. It must never
 * go in SWR: an SWR key survives unmount, so returning to the page would
 * redisplay a live credential with no re-auth, on a shared workstation.
 */

/**
 * How many leading characters of the token are stored as the NON-SECRET prefix
 * and shown to anyone who can view this instrument.
 *
 * Load-bearing for the warning below: a token this short or shorter is fully
 * disclosed by the prefix alone — no password, no audit row. The operator asked
 * for no length limit (2026-08-07), so the rule became a warning at the point
 * of entry instead of a refusal after it.
 *
 * The prefix is no longer rendered anywhere in the UI (2026-08-19), but
 * `GET /api/instruments/:id` still returns it to anyone holding INSTRUMENT_READ,
 * so the warning is about the API, not about this field.
 */
const TOKEN_PREFIX_LEN = 8;

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
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');

  const shown = Boolean(token);
  /**
   * The mask shows NOTHING of the token (operator request, 2026-08-19).
   *
   * It used to render the 8-character prefix followed by bullets, on the
   * reasoning that the prefix is non-secret and lets an operator match a device
   * against its config sheet without spending a password. The operator's call is
   * that a masked field showing real characters does not read as masked — and for
   * a short token the prefix IS most of the credential.
   *
   * A fixed bullet count, not the token's length: a mask that varies with the
   * value leaks how long the credential is. `tokenPrefix` is still what tells us
   * a credential EXISTS at all — no prefix, no credential, hence the em dash.
   */
  const masked = tokenPrefix ? '•'.repeat(32) : '—';

  const run = async (fn: () => Promise<void> | void) => {
    setBusy(true);
    try { await fn(); } finally { setBusy(false); }
  };

  const startEdit = () => { setDraft(token ?? ''); setEditing(true); };

  const submit = async () => {
    const next = draft.trim();
    if (!next || next === token) { setEditing(false); return; }
    await run(async () => {
      await onSetToken(next);
      setEditing(false);
    });
  };

  // The only rule left is a physical one: a token carrying a line break cannot
  // survive an HTTP header or the newline-delimited TCP protocol, so it would
  // authenticate nowhere. Everything else — length, symbols, spaces — is the
  // operator's call.
  const draftError = /[\r\n]/.test(draft) ? 'A token cannot contain a line break.' : '';
  const shortWarning = draft.trim().length > 0 && draft.trim().length <= TOKEN_PREFIX_LEN;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
        {editing ? (
          <Input
            className="min-w-0 flex-1 font-mono text-xs"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            aria-label="Access token"
            placeholder="The device's credential"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submit(); } }}
          />
        ) : (
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-slate-800" title={shown ? token! : undefined}>
            {shown ? token : masked}
          </code>
        )}

        {!editing && canEdit && tokenRevealable && (
          <Button variant="outline"
            type="button"
            disabled={busy}
            onClick={() => (shown ? onHide() : void run(onReveal))}
            aria-label={shown ? 'Hide token' : 'Show token'}
            title={shown ? 'Hide token' : 'Show token — asks for your password and is recorded in the audit trail'}
          >
            <EyeIcon open={shown} />
          </Button>
        )}

        {!editing && shown && (
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

        {/* Editing is IN PLACE on the value shown, so it needs the value: with
            the token still masked, Edit shows it first (password + audit row)
            and then opens the field. */}
        {!editing && canEdit && (
          <Button
            type="button" size="sm" variant="secondary" disabled={busy}
            onClick={() => (shown ? startEdit() : void run(async () => { await onReveal(); }))}
          >
            {shown ? 'Edit' : 'Edit…'}
          </Button>
        )}

        {editing && (
          <>
            <Button type="button" size="sm" disabled={busy || !draft.trim()} onClick={() => void submit()}>
              {busy ? 'Saving…' : 'Save token'}
            </Button>
            <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => { setEditing(false); setDraft(''); }}>
              Cancel
            </Button>
          </>
        )}
      </div>

      {/* The prefix leak, said where the value is typed rather than after it is
          refused. There is no length rule any more — this is the consequence of
          that, and the operator decides. */}
      {shortWarning && (
        <p className="text-xs text-amber-700">
          {TOKEN_PREFIX_LEN} characters or fewer: the whole token is stored as the
          non-secret prefix, which the API returns to anyone who can read this
          instrument — no password, and no audit record of the view.
        </p>
      )}

      {editing && (
        <p className="text-xs text-amber-800">
          Saving revokes the current token. <strong>{code}</strong> stops sending
          data until the device is reconfigured with the new value. Your password
          is required.
        </p>
      )}

      {/* One line, and it stays. The disclosure is the control the reveal was
          granted on (spec §3.1) — an operator asked to accept an attributable
          view has to be able to SEE that it is attributable. */}
      {!editing && canEdit && tokenRevealable && (
        <p className="text-xs text-slate-500">
          {shown
            ? 'This view was recorded in the audit trail against your user. The token hides again when you leave this page.'
            : 'Showing the token asks for your password and records the view in the audit trail.'}
        </p>
      )}

      {canEdit && !tokenRevealable && (
        // Not revealable: the credential predates the encryption, or the server
        // has no INSTRUMENT_TOKEN_KEY. It cannot be shown, so it cannot be
        // edited in place either — regenerating is the way out.
        <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
          <p className="text-xs text-slate-600">
            This token cannot be shown or edited — it was issued before tokens
            were stored recoverably, or the server has no token encryption key.
            Regenerating issues one that can be shown; the device stops working
            until it is reconfigured.
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
    </div>
  );
}
