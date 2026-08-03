import { useEffect, useState } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';
import {
  SEVERITY_LABELS, STATE_LABELS, describeThreshold, formatNumber, formatTimestamp,
  measurementLabel, type AlarmRow,
} from './alarm-shared';

interface Props {
  /** The alarm being signed, or null when the dialog is closed. */
  alarm: AlarmRow | null;
  onClose: () => void;
  /** Signature accepted — the caller should refresh its list. */
  onAcknowledged: () => void;
  /**
   * The alarm moved on before the signature landed (409). Nothing was signed,
   * and the list the caller is showing is stale, so it must refetch.
   *
   * Named for what the caller should DO, not for what happened, because the
   * first version of this was called `onStale` and the queue "handled
   * staleness" by closing the dialog — which unmounted the 409 message on the
   * commit that set it, leaving the operator unable to tell an
   * already-acknowledged alarm from one that re-breached. This callback must
   * refresh only; the dialog owns its own dismissal via `onClose`.
   */
  onRefreshRequested: () => void;
}

/** Extracts the backend's error code from either error shape api-client throws. */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; error?: unknown };
  // Normal failures come back as an Error carrying `.code`; REAUTH_* failures
  // are re-thrown as the raw parsed body, which carries `.error` instead.
  if (typeof e.code === 'string') return e.code;
  if (typeof e.error === 'string') return e.error;
  return undefined;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'object' && err !== null) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m;
  }
  return 'The acknowledgement could not be recorded.';
}

export function AlarmAckDialog({ alarm, onClose, onAcknowledged, onRefreshRequested }: Props) {
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Set on either 409. This dialog signs against the alarm snapshot it was
  // opened with, and that snapshot is now known to be stale — retrying would
  // post the same stale read and fail identically. Block submit and make the
  // operator reopen against fresh facts rather than letting them jab a button
  // that cannot succeed.
  const [staleRead, setStaleRead] = useState(false);

  // Reset per alarm — a reason typed against one excursion must never carry
  // over and end up signed against a different one.
  useEffect(() => {
    setReason('');
    setPassword('');
    setError(null);
    setSubmitting(false);
    setStaleRead(false);
  }, [alarm?.id]);

  if (!alarm) return null;

  const reasonValid = reason.trim().length > 0;
  const canSubmit = reasonValid && password.length > 0 && !submitting && !staleRead;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // postWithReauth puts the password in both the `_currentPassword` body
      // field and the x-reauth-password header, which is the shape
      // enforceReauthAlways reads. The challenge is intrinsic to this action
      // (21 CFR §11.50) and cannot be switched off in the reauth config, so
      // there is deliberately no passwordless branch here.
      await apiClient.postWithReauth(
        `/api/alarms/${alarm.id}/acknowledge`,
        { reason: reason.trim() },
        password,
      );
      onAcknowledged();
    } catch (err) {
      const code = errorCode(err);
      // The two 409s mean different things and must not be collapsed. Telling
      // an operator "already acknowledged" when the alarm in fact re-breached
      // would send them away from a live excursion.
      if (code === 'ALREADY_ACKNOWLEDGED') {
        setError('This alarm has already been acknowledged — someone else signed it first. '
          + 'The queue behind this dialog has been refreshed; no second signature was recorded. '
          + 'Close this dialog to review the current state.');
        setStaleRead(true);
        setSubmitting(false);
        onRefreshRequested();
        return;
      }
      if (code === 'ALARM_STATE_CHANGED') {
        setError('This alarm changed state while you were signing — it may have re-breached or been '
          + 'resolved. Nothing was signed. Close this dialog and reopen it to sign against the '
          + 'current state — the queue behind it has been refreshed.');
        setStaleRead(true);
        setSubmitting(false);
        onRefreshRequested();
        return;
      }
      if (code === 'REAUTH_FAILED' || code === 'INVALID_PASSWORD') {
        setError('That password was not accepted. Re-enter it to sign.');
        setPassword('');
        setSubmitting(false);
        return;
      }
      setError(errorMessage(err));
      setSubmitting(false);
    }
  };

  return (
    <Dialog open onClose={submitting ? () => {} : onClose}>
      <DialogHeader>
        <DialogTitle>Acknowledge alarm</DialogTitle>
        <p className="mt-1 text-sm text-slate-500">
          Your password is an electronic signature under 21 CFR §11.50. It is always
          required for this action and cannot be waived by configuration.
        </p>
      </DialogHeader>

      {/* The facts being signed against. Signing a bare "acknowledge" button
          without the excursion in front of the operator is what makes a
          signature meaningless. */}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm">
        <div className="col-span-2">
          <dt className="text-xs text-slate-500">Instrument</dt>
          <dd className="text-slate-900">
            {alarm.instrument.name} <span className="font-mono text-xs text-slate-400">{alarm.instrument.code}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Measurement</dt>
          <dd className="text-slate-900">{measurementLabel(alarm.key)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Limit</dt>
          <dd className="text-slate-900">
            {alarm.threshold ? describeThreshold(alarm.threshold) : 'No reading within expected interval'}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Severity</dt>
          <dd className="text-slate-900">{SEVERITY_LABELS[alarm.severity]}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">State</dt>
          <dd className="text-slate-900">{STATE_LABELS[alarm.state]}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Breach count</dt>
          <dd className="tabular-nums text-slate-900">{alarm.breachCount}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Peak value</dt>
          <dd className="tabular-nums text-slate-900">{formatNumber(alarm.peakValue)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">First breach</dt>
          <dd className="text-slate-700">{formatTimestamp(alarm.firstBreachAt)}</dd>
        </div>
        <div>
          <dt className="text-xs text-slate-500">Last breach</dt>
          <dd className="text-slate-700">{formatTimestamp(alarm.lastBreachAt)}</dd>
        </div>
      </dl>

      <div className="mt-4 space-y-4">
        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            Reason <span className="text-red-600">*</span>
          </span>
          <textarea
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            autoFocus
            placeholder="Why is this excursion being acknowledged? This is stored with your signature."
            className="mt-1 w-full rounded border border-slate-200 px-3 py-2 text-sm
                       focus:border-slate-400 focus:outline-none"
          />
          {!reasonValid && reason.length > 0 && (
            <span className="mt-1 block text-xs text-amber-700">
              A reason of only spaces is not a reason — describe the disposition.
            </span>
          )}
        </label>

        <label className="block">
          <span className="text-sm font-medium text-slate-700">
            Password <span className="text-red-600">*</span>
          </span>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full rounded border border-slate-200 px-3 py-2 text-sm
                       focus:border-slate-400 focus:outline-none"
          />
        </label>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {error}
          </div>
        )}
      </div>

      <DialogFooter>
        {/* After a 409 there is nothing left to cancel — the signature never
            happened and submit is blocked — so the button says what it does. */}
        <Button variant="outline" onClick={onClose} disabled={submitting}>
          {staleRead ? 'Close' : 'Cancel'}
        </Button>
        <Button onClick={submit} disabled={!canSubmit}>
          {submitting ? 'Signing…' : 'Sign and acknowledge'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
