import { useEffect, useState } from 'react';
import { validateAttributeRemark, ATTRIBUTE_REMARK_MAX } from '@digilog/shared';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';

/**
 * The mandatory remark on an attribute change.
 *
 * ONE dialog for both changing and removing, because they demand the same thing
 * and two dialogs would be two places for the rule to drift. The destructive
 * case only changes the wording and the button colour.
 *
 * Why a dialog rather than a field beside the value: the remark is not part of
 * the value being typed, it is a statement about the change, and putting it in
 * the row made it read as another attribute. It also gives the operator a last
 * look at what they are about to overwrite — the before and after are shown
 * here, which no inline field could do.
 *
 * The validator is the SHARED one the endpoint runs. A dialog that accepted
 * something the API refuses would surface as a failed save with a message the
 * operator has no way to act on.
 */
/** One line of a batch: what is shown for the key, and the values either side. */
export interface RemarkChange { label: string; from: string; to: string }

export interface RemarkDialogProps {
  open: boolean;
  attributeKey: string;
  /** Current value, so the operator sees what they are replacing. */
  from: string;
  /** New value. Absent for a removal. */
  to?: string;
  /**
   * SEVERAL changes signed with ONE remark (the Settings widget's inline
   * edit, 2026-09-16). When given, the single `attributeKey`/`from`/`to` are
   * not shown; every line is listed so the operator sees the whole of what
   * one reason will be recorded against.
   */
  changes?: RemarkChange[];
  /**
   * Overrides the attribute wording of the title. The Layout Designer signs a
   * ROOM's limit change through this same dialog (2026-10-05, DATA-11) and
   * "Change 2 attributes" would misname what is being recorded.
   */
  title?: string;
  destructive?: boolean;
  busy?: boolean;
  onSubmit: (remark: string) => void;
  onClose: () => void;
}

export function RemarkDialog({
  open, attributeKey, from, to, changes, title, destructive = false, busy = false, onSubmit, onClose,
}: RemarkDialogProps) {
  const [remark, setRemark] = useState('');
  const [touched, setTouched] = useState(false);

  // Cleared on every open. A remark left over from the previous change would be
  // submitted against a different attribute — a wrong reason in a §11 record is
  // worse than no dialog at all.
  useEffect(() => {
    if (open) { setRemark(''); setTouched(false); }
  }, [open]);

  const problem = validateAttributeRemark(remark);
  const showProblem = touched && problem;

  const submit = () => {
    setTouched(true);
    if (problem) return;
    onSubmit(remark.trim());
  };

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} className="max-w-lg">
      <DialogHeader>
        <DialogTitle>
          {title ?? (changes
            ? `${destructive ? 'Remove' : 'Change'} ${changes.length} attribute${changes.length === 1 ? '' : 's'}${destructive ? ' from instruments' : ''}`
            : `${destructive ? 'Remove' : 'Change'} “${attributeKey}”`)}
        </DialogTitle>
      </DialogHeader>

      <div className="space-y-4">
        {changes ? (
          <dl className="grid grid-cols-[auto_1fr_auto_1fr] items-baseline gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            {changes.map((c) => (
              <div key={c.label} className="contents">
                <dt className="font-medium text-slate-700">{c.label}</dt>
                <dd className="font-mono text-slate-500">{c.from || <span className="italic text-slate-400">(empty)</span>}</dd>
                <dt className="text-slate-400">→</dt>
                <dd className="font-mono text-slate-800">{c.to || <span className="italic text-slate-400">(empty)</span>}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <dt className="text-slate-500">From</dt>
            <dd className="font-mono text-slate-800">{from || <span className="italic text-slate-400">(empty)</span>}</dd>
            {!destructive && (
              <>
                <dt className="text-slate-500">To</dt>
                <dd className="font-mono text-slate-800">{to || <span className="italic text-slate-400">(empty)</span>}</dd>
              </>
            )}
          </dl>
        )}

        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Remarks</span>
          <textarea
            autoFocus
            rows={3}
            value={remark}
            maxLength={ATTRIBUTE_REMARK_MAX}
            onChange={(e) => setRemark(e.target.value)}
            onBlur={() => setTouched(true)}
            className="ctl w-full"
            placeholder="Why is this changing?"
          />
          {/* One line, and it stays: this is the §11 disclosure — an operator
              asked to sign for a change has to be able to see that they are. */}
          <span className="block text-xs text-slate-500">
            Recorded in the audit trail against your user.
          </span>
          {showProblem && <span className="block text-xs text-red-600">{problem}</span>}
        </label>

        <div className="flex items-center justify-end gap-3">
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy}
            onClick={submit}
          >
            {busy ? 'Saving…' : destructive ? (changes ? 'Remove attributes' : 'Remove attribute') : changes ? 'Save changes' : 'Save change'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
