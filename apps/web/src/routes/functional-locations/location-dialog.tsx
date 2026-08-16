import { useEffect, useState } from 'react';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';

export interface BlockOption { id: string; name: string }

export interface LocationDraft {
  id?: string;
  name: string;
  type: 'BLOCK' | 'AREA';
  parentId: string | null;
}

interface Props {
  open: boolean;
  /** Present when editing; absent when creating. */
  initial?: LocationDraft;
  blocks: BlockOption[];
  /** Pre-selects the parent when adding an Area from a Block's row. */
  presetParentId?: string | null;
  onClose: () => void;
  onSubmit: (draft: LocationDraft) => Promise<void>;
}

/**
 * Create or rename a functional location.
 *
 * The parent selector appears ONLY when type is Area. A Block cannot have a
 * parent — the API rejects it — so showing the field in Block mode would offer a
 * control whose every value is invalid.
 */
export function LocationDialog({ open, initial, blocks, presetParentId, onClose, onSubmit }: Props) {
  const [name, setName] = useState('');
  const [type, setType] = useState<'BLOCK' | 'AREA'>('BLOCK');
  const [parentId, setParentId] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setName(initial?.name ?? '');
    setType(initial?.type ?? (presetParentId ? 'AREA' : 'BLOCK'));
    setParentId(initial?.parentId ?? presetParentId ?? '');
    setError('');
  }, [open, initial, presetParentId]);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await onSubmit({
        id: initial?.id,
        name,
        type,
        parentId: type === 'AREA' ? (parentId || null) : null,
      });
      onClose();
    } catch (e) {
      // The API's message names the offending field and is written for an
      // operator; surface it rather than a generic failure.
      setError((e as Error).message || 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogHeader>
        {/* "Edit", not "Rename": in edit mode an Area's Block picker is live, so
            this dialog can move a location as well as rename it. */}
        <DialogTitle>{initial ? 'Edit functional location' : 'New functional location'}</DialogTitle>
      </DialogHeader>

      <div className="space-y-4 p-6 pt-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Functional location name *</span>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Module-E" autoFocus />
        </label>

        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Type *</span>
          <Select
            value={type}
            onChange={(e) => setType(e.target.value as 'BLOCK' | 'AREA')}
            disabled={Boolean(initial)}
          >
            <option value="BLOCK">Block</option>
            <option value="AREA">Area</option>
          </Select>
        </label>

        {type === 'AREA' && (
          <label className="block space-y-1">
            <span className="text-sm font-medium text-slate-700">Belongs to Block *</span>
            <Select value={parentId} onChange={(e) => setParentId(e.target.value)}>
              <option value="">Select a Block…</option>
              {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </label>
        )}

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
        <Button onClick={submit} disabled={saving || !name.trim() || (type === 'AREA' && !parentId)}>
          {saving ? 'Saving…' : initial ? 'Save' : 'Create'}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
