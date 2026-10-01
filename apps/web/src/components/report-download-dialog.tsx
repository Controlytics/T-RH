import { useEffect, useState } from 'react';
import useSWR from 'swr';
import {
  INTERVALS, REPORT_APPROVERS_NONE_MESSAGE, coerceReportApprovers,
  type ReportKind, type ReportKindPolicy, type ReportDownloadMode,
} from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { SignaturePasswordInput } from '@/components/ui/signature-password-input';
import { useReportDownloads } from '@/hooks/use-report-downloads';

export interface ReportPeriod { from: string; to: string; label: string }
export interface ReportDownloadRequest {
  period: ReportPeriod;
  /** '' when the report type's remarks are switched off. */
  remarks: string;
  /** The signature, when the report type requires one; absent otherwise. */
  password?: string;
  /** The interval chosen in the dialog, in ms; `null` = Raw. Present only when
   *  the dialog was opened with `showInterval`. */
  intervalMs?: number | null;
  /** What the dialog offered: DIRECT saves the PDF, REQUEST sends it for
   *  approval. The server re-checks it against the configuration. */
  mode: ReportDownloadMode;
}

const MAX_REMARKS = 500;

/**
 * The governed gate every report download goes through.
 *
 * Since 2026-10-01 it SHAPES ITSELF from the report type's configuration
 * (Configuration → Report Downloads — see `@digilog/shared/report-downloads`):
 *
 *   - Direct → "Download — <report>" and a Download button; the caller saves
 *     the PDF after the audit write.
 *   - Request → "Request approval — <report>", the configured approvers named,
 *     and a Request approval button. The requester no longer chooses who
 *     approves (operator: "per user or per role option should be removed in
 *     request place and add that in configuration") — the "Send to" picker is
 *     gone.
 *   - A remarks box only when the type requires remarks, a password box only
 *     when it requires the password.
 *
 * The password is collected HERE, beside the remarks, as one deliberate act —
 * the acknowledge dialog's shape — rather than through the re-auth hook, whose
 * per-role policy no longer decides these PDFs. `policy` overrides the
 * configured one for a surface outside it (the Audit Trail's Excel export).
 *
 * Nothing is enforced here: the server refuses a mode, a blank remark or a
 * missing password the configuration requires. This is presentation.
 */
export function ReportDownloadDialog({
  open, reportName, kind, policy: policyOverride, initialPeriod, showPeriod = true, showInterval = false, initialIntervalMs = null,
  progress = null, onCancel, onConfirm,
}: {
  open: boolean;
  reportName: string;
  /** Which configured report type this is. */
  kind: ReportKind;
  /** Replaces the configured policy — for a download the configuration does not govern. */
  policy?: ReportKindPolicy;
  /** Seeded from the period the page is currently showing. */
  initialPeriod: ReportPeriod;
  /** Hidden when the surface has no period (e.g. a full-list export). */
  showPeriod?: boolean;
  /**
   * Offer an interval selector under the period (operator, 2026-09-05:
   * *"interval selection should come at data report time period selection
   * below on top of remarks"*). Only the Data Report reads it.
   */
  showInterval?: boolean;
  /** Seeded from the page's chart interval; `null` = Raw. */
  initialIntervalMs?: number | null;
  /**
   * What the download is doing right now, for a report that takes a while —
   * "Read 7 of 30 instruments…". Shown above the buttons while busy.
   */
  progress?: string | null;
  onCancel: () => void;
  onConfirm: (req: ReportDownloadRequest) => Promise<void>;
}) {
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);
  const [intervalMs, setIntervalMs] = useState<number | null>(initialIntervalMs);
  const [remarks, setRemarks] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const { policy: configured, error: policyError } = useReportDownloads();
  const policy: ReportKindPolicy | undefined = policyOverride ?? configured?.[kind];
  const requesting = policy?.mode === 'REQUEST';
  const { data: approversData } = useSWR<unknown>(open && requesting ? '/api/config/report-approvers/current' : null);
  const approvers = approversData === undefined ? undefined : coerceReportApprovers(approversData);
  const noApprover = requesting && approvers !== undefined && approvers.approverRoles.length === 0 && approvers.approverUserIds.length === 0;

  // Re-seed from the page's current period, and clear stale state, each time
  // the dialog is (re)opened — not while it stays open, which would stomp on
  // what the operator is typing.
  useEffect(() => {
    if (open) {
      setFrom(initialPeriod.from);
      setTo(initialPeriod.to);
      setIntervalMs(initialIntervalMs);
      setRemarks('');
      setPassword('');
      setTouched(false);
      setBusy(false);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const trimmedRemarks = remarks.trim();
  const remarksError = policy?.remarksRequired && trimmedRemarks.length === 0 ? 'Remarks are required — state why this report was generated.' : null;
  const passwordError = policy?.passwordRequired && password.length === 0 ? 'Enter your password to sign.' : null;
  const canSubmit = !!policy && !remarksError && !passwordError && !noApprover && !busy;

  const handleConfirm = async () => {
    setTouched(true);
    if (!policy || remarksError || passwordError || noApprover) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm({
        period: { from, to, label: initialPeriod.label },
        remarks: policy.remarksRequired ? trimmedRemarks : '',
        ...(policy.passwordRequired ? { password } : {}),
        ...(showInterval ? { intervalMs } : {}),
        mode: policy.mode,
      });
    } catch (e: any) {
      // A download whose audit write failed must not look like it succeeded —
      // the error surfaces IN the dialog, which stays open. A wrong password
      // lands here too, beside the box it belongs to.
      setError(e?.error === 'REAUTH_FAILED' ? 'Incorrect password. Please try again.' : (e?.message ?? 'Could not generate the report. Please try again.'));
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  const verb = requesting ? 'Request approval' : 'Download';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="report-download-title" className="w-full max-w-lg rounded-lg bg-white shadow-[var(--elev-2)]">
        <div className="rounded-t-lg bg-gradient-to-r from-slate-700 to-slate-900 px-5 py-3">
          <h2 id="report-download-title" className="text-base font-semibold text-white">{policy ? `${verb} — ${reportName}` : reportName}</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          {!policy ? (
            <p className="text-sm text-slate-500">
              {policyError ? 'The report settings could not be loaded. Close and try again.' : 'Loading…'}
            </p>
          ) : (
            <>
              {showPeriod && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="report-download-from" className="mb-1 block text-sm font-medium text-slate-700">From</label>
                    <input
                      id="report-download-from"
                      type="datetime-local"
                      value={toLocalInput(from)}
                      onChange={(e) => setFrom(fromLocalInput(e.target.value))}
                      className="ctl w-full"
                    />
                  </div>
                  <div>
                    <label htmlFor="report-download-to" className="mb-1 block text-sm font-medium text-slate-700">To</label>
                    <input
                      id="report-download-to"
                      type="datetime-local"
                      value={toLocalInput(to)}
                      onChange={(e) => setTo(fromLocalInput(e.target.value))}
                      className="ctl w-full"
                    />
                  </div>
                </div>
              )}

              {showInterval && (
                <div>
                  <label htmlFor="report-download-interval" className="mb-1 block text-sm font-medium text-slate-700">Interval</label>
                  <select
                    id="report-download-interval"
                    value={intervalMs ?? ''}
                    onChange={(e) => setIntervalMs(e.target.value === '' ? null : Number(e.target.value))}
                    disabled={busy}
                    className="ctl w-full"
                  >
                    {INTERVALS.map((i) => (
                      <option key={i.value} value={i.seconds === null ? '' : i.seconds * 1000}>{i.label}</option>
                    ))}
                  </select>
                </div>
              )}

              {policy.remarksRequired && (
                <div>
                  <label htmlFor="report-download-remarks" className="mb-1 block text-sm font-medium text-slate-700">
                    Remarks <span className="text-red-600">*</span> — required
                  </label>
                  <textarea
                    id="report-download-remarks"
                    rows={3}
                    value={remarks}
                    onChange={(e) => setRemarks(e.target.value)}
                    onBlur={() => setTouched(true)}
                    maxLength={MAX_REMARKS}
                    disabled={busy}
                    className="ctl w-full"
                    placeholder="Why this report is being generated"
                  />
                  <p className="mt-1 text-xs text-slate-500">Recorded permanently in the audit trail against your name.</p>
                  {touched && remarksError && <p className="mt-1 text-xs text-red-600">{remarksError}</p>}
                </div>
              )}

              {policy.passwordRequired && (
                <div>
                  <label htmlFor="report-download-password" className="mb-1 block text-sm font-medium text-slate-700">
                    Password <span className="text-red-600">*</span> — your electronic signature
                  </label>
                  <SignaturePasswordInput id="report-download-password" value={password} onChange={setPassword} onEnter={handleConfirm} autoFocus={false} />
                  {touched && passwordError && <p className="mt-1 text-xs text-red-600">{passwordError}</p>}
                </div>
              )}

              {requesting && (
                noApprover ? (
                  <p role="alert" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">{REPORT_APPROVERS_NONE_MESSAGE}</p>
                ) : (
                  <p className="text-sm text-slate-600" data-testid="report-download-approvers">
                    Goes for approval to {approvers === undefined ? '…' : approverSummary(approvers.approverRoles, approvers.approverUserIds.length)}.
                    The approved copy is downloaded from <span className="font-medium">Reports</span>.
                  </p>
                )
              )}
            </>
          )}

          {busy && progress && (
            <p role="status" className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">{progress}</p>
          )}
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {busy ? (requesting ? 'Sending…' : 'Preparing…') : verb}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** "any SUPERVISOR or QA, and 2 named users" — who a request will reach. */
function approverSummary(roles: string[], userCount: number): string {
  const parts: string[] = [];
  if (roles.length) parts.push(`any ${roles.join(' or ')}`);
  if (userCount) parts.push(`${userCount} named user${userCount === 1 ? '' : 's'}`);
  return parts.join(', and ');
}

/** ISO string -> the value a `datetime-local` input needs (local time, no seconds/zone). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The reverse of `toLocalInput` — local `datetime-local` value back to ISO. */
function fromLocalInput(value: string): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}
