import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ackReasonError, conditionText, instrumentLabel, triggeredText, MAX_ACK_REASON, type AlarmRow } from './alarm-display';

/**
 * Acknowledging an alarm is a 21 CFR §11 e-signature, so the reason and the password are
 * collected TOGETHER in one deliberate act. Splitting them across two prompts would let
 * someone type a reason, get a password box, and no longer see what they are signing.
 *
 * The alarm being signed for is restated in the dialog for the same reason.
 */
export function AcknowledgeDialog({
  alarm, open, submitting, error, onSubmit, onClose,
}: {
  alarm: AlarmRow | null;
  open: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (reason: string, password: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (open) { setReason(''); setPassword(''); setTouched(false); }
  }, [open, alarm?.id]);

  if (!open || !alarm) return null;

  const reasonError = ackReasonError(reason);
  const canSubmit = !reasonError && password.length > 0 && !submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-xl">
        <div className="rounded-t-lg bg-gradient-to-r from-amber-500 to-red-500 px-5 py-3">
          <h2 className="text-base font-semibold text-white">Acknowledge Alarm</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          <dl className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Instrument</dt>
              <dd className="font-medium text-slate-900">{instrumentLabel(alarm)}</dd>
            </div>
            <div className="mt-1 flex justify-between gap-4">
              <dt className="text-slate-500">Condition</dt>
              <dd className="text-right text-slate-900">{conditionText(alarm)}</dd>
            </div>
            <div className="mt-1 flex justify-between gap-4">
              <dt className="text-slate-500">Reading</dt>
              <dd className="text-slate-900">{triggeredText(alarm)}</dd>
            </div>
          </dl>

          <div>
            <label htmlFor="ack-reason" className="mb-1 block text-sm font-medium text-slate-700">
              Reason <span className="text-red-600">*</span>
            </label>
            <textarea
              id="ack-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              onBlur={() => setTouched(true)}
              maxLength={MAX_ACK_REASON}
              className="ctl w-full"
              placeholder="What happened, and what was done about it"
            />
            <p className="mt-1 text-xs text-slate-500">
              Recorded permanently in the audit trail against your name.
            </p>
            {/* Shown as soon as anything has been typed, not only after blur: the submit
                button is disabled while the reason is too short, so waiting for blur left
                a dead end — a greyed-out button with nothing saying why. */}
            {(touched || reason.length > 0) && reasonError && (
              <p className="mt-1 text-xs text-red-600">{reasonError}</p>
            )}
          </div>

          <div>
            <label htmlFor="ack-password" className="mb-1 block text-sm font-medium text-slate-700">
              Password <span className="text-red-600">*</span>
            </label>
            <input
              id="ack-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="ctl w-full"
              autoComplete="off"
            />
          </div>

          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            onClick={() => { setTouched(true); if (canSubmit) onSubmit(reason.trim(), password); }}
            disabled={!canSubmit}
          >
            {submitting ? 'Signing…' : 'Acknowledge'}
          </Button>
        </div>
      </div>
    </div>
  );
}
