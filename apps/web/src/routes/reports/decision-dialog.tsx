import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { SignaturePasswordInput } from '@/components/ui/signature-password-input';
import type { ReviewSummary } from '@/lib/report-review';

/**
 * Approving or rejecting a report request is a 21 CFR §11 e-signature, so the
 * remarks and the password are collected TOGETHER in one deliberate act, with
 * the request restated — the same shape as the alarm acknowledge dialog, for
 * the same reason: whoever signs must see what they are signing.
 */
export function DecisionDialog({
  review, decision, open, submitting, error, onSubmit, onClose,
}: {
  review: ReviewSummary | null;
  decision: 'approve' | 'reject';
  open: boolean;
  submitting: boolean;
  error: string;
  onSubmit: (remarks: string, password: string) => void;
  onClose: () => void;
}) {
  const [remarks, setRemarks] = useState('');
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (open) { setRemarks(''); setPassword(''); }
  }, [open, review?.id, decision]);

  if (!open || !review) return null;

  const trimmed = remarks.trim();
  const canSubmit = trimmed.length > 0 && password.length > 0 && !submitting;
  const verb = decision === 'approve' ? 'Approve' : 'Reject';
  const period = review.requestMeta?.period;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="decision-dialog-title" className="w-full max-w-lg rounded-lg bg-white shadow-[var(--elev-2)]">
        <div className={`rounded-t-lg bg-gradient-to-r px-5 py-3 ${decision === 'approve' ? 'from-emerald-600 to-teal-700' : 'from-amber-500 to-red-500'}`}>
          <h2 id="decision-dialog-title" className="text-base font-semibold text-white">{verb} report request</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          <dl className="rounded-md border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-slate-500">Report</dt>
              <dd className="text-right font-medium text-slate-900">{review.title}</dd>
            </div>
            {period && (
              <div className="mt-1 flex justify-between gap-4">
                <dt className="text-slate-500">Period</dt>
                <dd className="text-right text-slate-900">{period.label}</dd>
              </div>
            )}
            <div className="mt-1 flex justify-between gap-4">
              <dt className="text-slate-500">Requested by</dt>
              <dd className="text-right text-slate-900">{review.requestedByName}</dd>
            </div>
            <div className="mt-1 flex justify-between gap-4">
              <dt className="text-slate-500">Their remarks</dt>
              <dd className="text-right text-slate-900">{review.requestRemarks}</dd>
            </div>
          </dl>

          <div>
            <label htmlFor="decision-remarks" className="mb-1 block text-sm font-medium text-slate-700">
              Remarks <span className="text-red-600">*</span>
            </label>
            <textarea
              id="decision-remarks"
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              rows={3}
              maxLength={500}
              className="ctl w-full"
              placeholder={decision === 'approve' ? 'What was checked, and against what.' : 'Why this report is not accepted.'}
            />
          </div>

          <div>
            <label htmlFor="decision-password" className="mb-1 block text-sm font-medium text-slate-700">
              Password <span className="text-red-600">*</span>
            </label>
            <SignaturePasswordInput id="decision-password" value={password} onChange={setPassword} placeholder="Your password signs this decision" />
          </div>

          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button onClick={() => onSubmit(trimmed, password)} disabled={!canSubmit}>
            {submitting ? 'Signing…' : verb}
          </Button>
        </div>
      </div>
    </div>
  );
}
