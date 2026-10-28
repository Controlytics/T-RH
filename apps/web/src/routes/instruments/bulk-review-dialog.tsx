import { useEffect, useState } from 'react';
import { validateAttributeRemark, ATTRIBUTE_REMARK_MAX } from '@digilog/shared';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

/** One change the server planned: the value it replaces (null = the instrument has none) and the new one. */
export interface PlannedChange { key: string; column: string; from: string | null; to: string }
export interface PlannedUpdate { id: string; code: string; row: number; changes: PlannedChange[] }
/** `POST /api/instruments/bulk/preview` — what the upload WOULD do. */
export interface BulkPreview {
  create: { row: number; code: string }[];
  update: PlannedUpdate[];
  unchanged: { row: number; code: string }[];
  errors: { row: number; column?: string; message: string }[];
  warnings: string[];
  /** The server's answer: the upload will refuse to overwrite a recorded value without one. */
  remarkRequired: boolean;
}

/** The cell a change replaces. A first fill says so in words — a blank cell would read as "set to empty". */
export function FromValue({ value }: { value: string | null }) {
  return value === null
    ? <span className="italic text-slate-400">Not set</span>
    : <span className="font-mono">{value || <span className="italic text-slate-400">(empty)</span>}</span>;
}

/**
 * The last look before a bulk upload changes instruments that already exist
 * (2026-10-28). Every change is listed — instrument, cell as the file heads it,
 * the value it replaces, the new one — because the remark below is recorded
 * against ALL of them, and an operator asked to sign must see what for (the
 * reason `RemarkDialog` shows before and after). A re-uploaded old file shows
 * up here as a list of reverts, which is the protection.
 *
 * Whether a remark is asked is `plan.remarkRequired`, the server's decision —
 * never re-derived from `from` here. The validator is the SHARED one the
 * upload runs.
 */
export function BulkReviewDialog({ plan, onConfirm, onClose }: {
  plan: BulkPreview | null;
  onConfirm: (remark?: string) => void;
  onClose: () => void;
}) {
  const [remark, setRemark] = useState('');
  const [touched, setTouched] = useState(false);
  // Cleared on every open: a remark left from an earlier file would be signed
  // against changes it was never written for.
  useEffect(() => { if (plan) { setRemark(''); setTouched(false); } }, [plan]);

  const needsRemark = plan?.remarkRequired ?? false;
  const problem = needsRemark ? validateAttributeRemark(remark) : null;
  const confirm = () => {
    setTouched(true);
    if (problem) return;
    onConfirm(needsRemark ? remark.trim() : undefined);
  };

  return (
    <Dialog open={plan !== null} onClose={onClose} className="max-w-3xl">
      <DialogHeader>
        <DialogTitle>Review the upload</DialogTitle>
      </DialogHeader>
      {plan && (
        <div className="space-y-4 px-5 pb-5">
          <p className="text-sm font-medium text-slate-700" data-testid="review-summary">
            {plan.create.length} new · {plan.update.length} to update · {plan.unchanged.length} unchanged
            {plan.errors.length > 0 && ` · ${plan.errors.length} rejected`}
          </p>
          <div className="max-h-[50vh] overflow-auto rounded-lg border border-slate-200">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Instrument ID</TableHead>
                  <TableHead>Field</TableHead>
                  <TableHead>Current</TableHead>
                  <TableHead>New</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {plan.update.flatMap((u) => u.changes.map((c) => (
                  <TableRow key={`${u.id}-${c.key}`} data-testid="review-change">
                    <TableCell className="font-mono text-xs">{u.code}</TableCell>
                    <TableCell>{c.column}</TableCell>
                    <TableCell><FromValue value={c.from} /></TableCell>
                    <TableCell className="font-mono font-semibold text-slate-900">{c.to}</TableCell>
                  </TableRow>
                )))}
              </TableBody>
            </Table>
          </div>
          {needsRemark && (
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Remarks</span>
              <textarea
                rows={3}
                value={remark}
                maxLength={ATTRIBUTE_REMARK_MAX}
                onChange={(e) => setRemark(e.target.value)}
                onBlur={() => setTouched(true)}
                className="ctl w-full"
                placeholder="Why are these values changing?"
              />
              {/* The §11 disclosure, as on every remark. */}
              <span className="block text-xs text-slate-500">Recorded in the audit trail against your user, on every change above.</span>
              {touched && problem && <span className="block text-xs text-red-600">{problem}</span>}
            </label>
          )}
          <div className="flex items-center justify-end gap-3">
            <Button type="button" variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
            <Button type="button" size="sm" onClick={confirm}>Upload</Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
