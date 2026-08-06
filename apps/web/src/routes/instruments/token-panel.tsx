import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

/**
 * Reveal / set / regenerate for an instrument's access token.
 *
 * ── Why a reveal exists at all ──
 * Spec `2026-08-04-instruments-inbound-ingestion-design.md` D5 said a token is
 * shown once and never again. That was reversed 2026-08-06 (see §3.1 there) on
 * three compensating controls: encrypted at rest, permission + always-on
 * password re-auth, and an `INSTRUMENT_TOKEN_VIEWED` audit row per view. The
 * third is the one that makes a retrievable credential acceptable, and it is
 * why this panel says so on screen rather than quietly recording it — an
 * operator who does not know the view is attributable is being asked to accept
 * a control they cannot see.
 *
 * ── The revealed value is deliberately NOT owned here ──
 * It lives in the parent route's `useState`, for two reasons. The revealed
 * token has to reach the connection panel (the labelled Token/Username rows AND
 * the paste-ready command, which is useless with a placeholder in it), and
 * route state unmounts when the operator navigates away — which is exactly the
 * required re-hide. It must never go in SWR: an SWR key survives unmount, so
 * coming back to the page would redisplay a live credential with no re-auth, on
 * a shared workstation, silently. Local state is the mechanism, not an
 * accident.
 */

/** The server's rule, from `setInstrumentTokenSchema` in @digilog/shared. */
const TOKEN_RULE = '32–128 characters. Letters, digits, dot, dash and underscore only.';
const TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface TokenPanelProps {
  code: string;
  /** First 8 characters of the live token, or null if there is no credential. */
  tokenPrefix: string | null;
  /**
   * From the instrument detail response. False for a credential issued before
   * the encryption landed, or when no INSTRUMENT_TOKEN_KEY is configured — in
   * both cases a Reveal can only produce an error, so it is not offered.
   */
  tokenRevealable: boolean;
  canEdit: boolean;
  /** The revealed value, owned by the route. Null while hidden. */
  token: string | null;
  onHide: () => void;
  onReveal: () => Promise<void> | void;
  onSetToken: (token: string) => Promise<void>;
  onRegenerate: () => Promise<void> | void;
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
    : draft.length < 32 ? 'Too short — 32 characters minimum.'
    : draft.length > 128 ? 'Too long — 128 characters maximum.'
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

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <span className="text-slate-500">Token prefix</span>
        <span className="font-mono text-xs text-slate-800">
          {tokenPrefix ? `${tokenPrefix}…` : '—'}
        </span>
      </div>

      {token ? (
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <span className="text-sm font-medium text-slate-700">Access token for {code}</span>
            <div className="flex gap-2">
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
              <Button type="button" size="sm" variant="secondary" onClick={onHide}>Hide</Button>
            </div>
          </div>
          <pre className="overflow-x-auto rounded-lg border border-slate-300 bg-slate-900 p-3 text-xs text-emerald-300 break-all whitespace-pre-wrap">
            {token}
          </pre>
          <p className="text-xs text-slate-500">
            This view was recorded in the audit trail against your user. The
            token is hidden again when you leave this page.
          </p>
        </div>
      ) : canEdit && tokenRevealable ? (
        <div className="space-y-1">
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void run(onReveal)}>
            {busy ? 'Working…' : 'Reveal token'}
          </Button>
          <p className="text-xs text-slate-500">
            Asks for your password, and records the view in the audit trail.
          </p>
        </div>
      ) : canEdit ? (
        // Not revealable: the credential predates the encryption, or the server
        // has no INSTRUMENT_TOKEN_KEY. Rendering a Reveal button here would
        // spend the operator's password to reach an error, so it is replaced
        // with the action that actually resolves the situation.
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
          <p className="text-xs text-slate-600">
            This token cannot be shown. It was issued before tokens were stored
            recoverably, or the server has no token encryption key configured.
            Regenerating issues one that can be revealed — the device stops
            working until it is reconfigured with the new value.
          </p>
          <Button
            type="button" size="sm" variant="secondary" className="mt-2"
            disabled={busy} onClick={() => void run(onRegenerate)}
          >
            Regenerate token
          </Button>
        </div>
      ) : (
        <p className="text-xs text-slate-500">
          You do not have permission to view or change this instrument&apos;s token.
        </p>
      )}

      {canEdit && (
        <div className="border-t border-slate-200 pt-3">
          {!settingOpen ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setSettingOpen(true)}>
              Set a specific token
            </Button>
          ) : (
            <div className="space-y-2">
              <div>
                <span className="text-sm font-medium text-slate-700">Set a specific token</span>
                {/* The rules are stated BEFORE the field, not only as a
                    validation error: the value is usually copied off a device's
                    config sheet, and finding out after the fact that it is
                    unusable means going back to the device. */}
                <p className="mt-0.5 text-xs text-slate-500">{TOKEN_RULE}</p>
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
      )}
    </div>
  );
}
