import { useEffect, useState } from 'react';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/** The server's limits (`DASHBOARD_TITLE_MAX` / `DASHBOARD_DESCRIPTION_MAX`). */
export const TITLE_MAX = 200;
export const DESCRIPTION_MAX = 500;

export interface NameValues { title: string; description: string }

/**
 * New dashboard and Rename share one form: a title and an optional
 * description. It only collects; the page runs the re-authenticated write and
 * hands the outcome back as `busy` / `error`.
 */
export function NameDialog({
  open, mode, initial, seedKey, busy, error, onSubmit, onClose,
}: {
  open: boolean;
  mode: 'new' | 'rename';
  initial?: NameValues;
  /** Changes when the dialog must be re-seeded while open (a refused Rename shows the fresh row). */
  seedKey?: string;
  busy: boolean;
  error: string | null;
  onSubmit: (v: NameValues) => void;
  onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  // Re-seed on every open, so a Rename always starts from the row it was opened on.
  useEffect(() => {
    if (open) {
      setTitle(initial?.title ?? '');
      setDescription(initial?.description ?? '');
    }
  }, [open, seedKey, initial?.title, initial?.description]);

  const trimmed = title.trim();
  const heading = mode === 'new' ? 'New dashboard' : 'Rename dashboard';

  return (
    <Dialog open={open} onClose={() => { if (!busy) onClose(); }} className="max-w-lg">
      <DialogBanner title={heading} subtitle={mode === 'new' ? 'Starts empty, showing every instrument' : undefined} />
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (trimmed && !busy) onSubmit({ title: trimmed, description: description.trim() }); }}
      >
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Title</span>
          <Input name="dashboard-title" value={title} maxLength={TITLE_MAX} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-slate-700">Description</span>
          <Input name="dashboard-description" value={description} maxLength={DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} />
        </label>
        {error && <p role="alert" className="text-sm font-medium text-red-700">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={!trimmed || busy}>
            {busy ? 'Saving…' : mode === 'new' ? 'Create dashboard' : 'Save'}
          </Button>
        </DialogFooter>
      </form>
    </Dialog>
  );
}
