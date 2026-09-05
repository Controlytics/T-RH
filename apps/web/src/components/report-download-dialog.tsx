import { useEffect, useState } from 'react';
import { INTERVALS } from '@digilog/shared';
import { Button } from '@/components/ui/button';

export interface ReportPeriod { from: string; to: string; label: string }
export interface ReportDownloadRequest {
  period: ReportPeriod;
  remarks: string;
  password?: string;
  /** The interval chosen in the dialog, in ms; `null` = Raw. Present only when
   *  the dialog was opened with `showInterval`. */
  intervalMs?: number | null;
}

const MAX_REMARKS = 500;

/**
 * The governed gate every report download goes through: a period, a
 * mandatory remarks field, and Cancel/Download.
 *
 * This dialog does NOT call the reauth prompt itself. The caller wraps
 * `onConfirm` in `reauth.execute('DOWNLOAD_REPORT', …)`, exactly like every
 * other reauth-guarded action in this codebase — one reauth pattern, not two.
 * `password`, when the caller's reauth flow supplies one, just rides along
 * in the confirm payload for `logReportExport`.
 *
 * Shape follows `AcknowledgeDialog` (gradient header, restated subject,
 * required-reason textarea) — that is the existing convention for a §11
 * reason-collecting dialog, so there is no reason for a second one.
 */
export function ReportDownloadDialog({
  open, reportName, initialPeriod, showPeriod = true, showInterval = false, initialIntervalMs = null,
  progress = null, onCancel, onConfirm,
}: {
  open: boolean;
  reportName: string;
  /** Seeded from the period the page is currently showing. */
  initialPeriod: ReportPeriod;
  /** Hidden when the surface has no period (e.g. a full-list export). */
  showPeriod?: boolean;
  /**
   * Offer an interval selector under the period (operator, 2026-09-05:
   * *"interval selection should come at data report time period selection
   * below on top of remarks"*). Only the Data Report reads it; the other
   * reports leave it off and the request carries no `intervalMs`.
   */
  showInterval?: boolean;
  /** Seeded from the page's chart interval; `null` = Raw. */
  initialIntervalMs?: number | null;
  /**
   * What the download is doing right now, for a report that takes a while —
   * "Reading CWH/RDU/003-01 (7 of 30)…". Shown above the buttons while busy.
   * A multi-instrument report reads every instrument in turn, and a spinner
   * alone over a thirty-second wait reads as a hang.
   */
  progress?: string | null;
  onCancel: () => void;
  onConfirm: (req: ReportDownloadRequest) => Promise<void>;
}) {
  const [from, setFrom] = useState(initialPeriod.from);
  const [to, setTo] = useState(initialPeriod.to);
  const [intervalMs, setIntervalMs] = useState<number | null>(initialIntervalMs);
  const [remarks, setRemarks] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Re-seed from the page's current period, and clear stale state, each time
  // the dialog is (re)opened — not while it stays open, which would stomp on
  // what the operator is typing.
  useEffect(() => {
    if (open) {
      setFrom(initialPeriod.from);
      setTo(initialPeriod.to);
      setIntervalMs(initialIntervalMs);
      setRemarks('');
      setTouched(false);
      setBusy(false);
      setError('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  if (!open) return null;

  const trimmedRemarks = remarks.trim();
  const remarksError = trimmedRemarks.length === 0 ? 'Remarks are required — state why this report was generated.' : null;
  const canSubmit = !remarksError && !busy;

  const handleConfirm = async () => {
    setTouched(true);
    if (remarksError) return;
    setBusy(true);
    setError('');
    try {
      await onConfirm({
        period: { from, to, label: initialPeriod.label },
        remarks: trimmedRemarks,
        ...(showInterval ? { intervalMs } : {}),
      });
    } catch (e: any) {
      // A download whose audit write failed must not look like it succeeded —
      // the error surfaces IN the dialog, which stays open.
      setError(e?.message ?? 'Could not generate the report. Please try again.');
      setBusy(false);
      return;
    }
    setBusy(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-lg bg-white shadow-[var(--elev-2)]">
        <div className="rounded-t-lg bg-gradient-to-r from-slate-700 to-slate-900 px-5 py-3">
          <h2 className="text-base font-semibold text-white">Download Report — {reportName}</h2>
        </div>

        <div className="space-y-4 px-5 py-4">
          {showPeriod && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="report-download-from" className="mb-1 block text-sm font-medium text-slate-700">
                  From
                </label>
                <input
                  id="report-download-from"
                  type="datetime-local"
                  value={toLocalInput(from)}
                  onChange={(e) => setFrom(fromLocalInput(e.target.value))}
                  className="ctl w-full"
                />
              </div>
              <div>
                <label htmlFor="report-download-to" className="mb-1 block text-sm font-medium text-slate-700">
                  To
                </label>
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
              <label htmlFor="report-download-interval" className="mb-1 block text-sm font-medium text-slate-700">
                Interval
              </label>
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
            <p className="mt-1 text-xs text-slate-500">
              Recorded permanently in the audit trail against your name.
            </p>
            {touched && remarksError && (
              <p className="mt-1 text-xs text-red-600">{remarksError}</p>
            )}
          </div>

          {busy && progress && (
            <p role="status" className="rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-600">{progress}</p>
          )}
          {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">
          <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
          <Button onClick={handleConfirm} disabled={!canSubmit}>
            {busy ? 'Downloading…' : 'Download'}
          </Button>
        </div>
      </div>
    </div>
  );
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
