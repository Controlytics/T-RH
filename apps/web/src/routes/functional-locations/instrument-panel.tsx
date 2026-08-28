import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

interface Linkable {
  id: string;
  code: string;
  name: string;
  functionalLocationId: string | null;
  functionalLocationPath: string | null;
}

interface Props {
  locationId: string;
  locationPath: string;
  canEdit: boolean;
  onChanged: () => void;
}

/**
 * The Relation section: which instruments report under this location.
 *
 * Modelled on gateway-panel.tsx, which solves the same problem (list members,
 * pick from candidates, unlink).
 *
 * AN INSTRUMENT HAS AT MOST ONE LOCATION, enforced by a single FK. So selecting
 * one that already belongs elsewhere MOVES it. That is legitimate and documented,
 * but it must never be silent: those rows show their current location and the
 * confirm step names every instrument being moved.
 */
export function InstrumentPanel({ locationId, locationPath, canEdit, onChanged }: Props) {
  const { data, mutate } = useSWR<{ data: Linkable[] }>('/api/functional-locations/linkable-instruments');
  const { toast } = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const all = data?.data ?? [];
  const linked = useMemo(() => all.filter((i) => i.functionalLocationId === locationId), [all, locationId]);

  useEffect(() => {
    if (pickerOpen) setSelected(new Set(linked.map((i) => i.id)));
  }, [pickerOpen, linked]);

  const candidates = useMemo(() => {
    const q = query.trim().toLowerCase();
    return all
      .filter((i) => !q || i.code.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [all, query]);

  /** Selected instruments that currently belong to a DIFFERENT location. */
  const moving = useMemo(
    () => candidates.filter((i) => selected.has(i.id) && i.functionalLocationId && i.functionalLocationId !== locationId),
    [candidates, selected, locationId],
  );

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiClient.put<{ linked: number; unlinked: number; moved: number }>(
        `/api/functional-locations/${locationId}/instruments`,
        { instrumentIds: [...selected] },
      );
      const bits = [
        res.linked ? `${res.linked} linked` : null,
        res.unlinked ? `${res.unlinked} unlinked` : null,
        res.moved ? `${res.moved} moved from another location` : null,
      ].filter(Boolean).join(', ');
      toast.success('Instruments updated', bits || 'No changes.');
      setPickerOpen(false);
      await mutate();
      onChanged();
    } catch (e) {
      toast.error('Could not update instruments', (e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const unlink = async (inst: Linkable) => {
    try {
      await apiClient.put(`/api/functional-locations/${locationId}/instruments`, {
        instrumentIds: linked.filter((i) => i.id !== inst.id).map((i) => i.id),
      });
      toast.success('Instrument unlinked', `"${inst.code}" no longer belongs to ${locationPath}.`);
      await mutate();
      onChanged();
    } catch (e) {
      toast.error('Could not unlink', (e as Error).message);
    }
  };

  return (
    <div className="rounded-[var(--radius-card)] border border-slate-200 bg-white p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-slate-800">
          Instruments in {locationPath} <span className="font-normal text-slate-500">({linked.length})</span>
        </h3>
        {canEdit && <Button onClick={() => setPickerOpen(true)}>Add instruments</Button>}
      </div>

      {linked.length === 0 ? (
        <p className="text-sm text-slate-500">No instruments linked yet.</p>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {linked.map((i) => (
            <div key={i.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate font-mono text-sm font-medium text-slate-800">{i.code}</p>
                <p className="truncate text-xs text-slate-500">{i.name}</p>
              </div>
              {canEdit && (
                <button
                  type="button"
                  onClick={() => unlink(i)}
                  className="shrink-0 text-xs font-semibold text-red-600 hover:underline"
                >
                  Unlink
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <DialogHeader><DialogTitle>Instruments in {locationPath}</DialogTitle></DialogHeader>
        <div className="space-y-3 p-6 pt-2">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by ID or name…" />

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {candidates.map((i) => {
              const elsewhere = i.functionalLocationId && i.functionalLocationId !== locationId;
              return (
                <label key={i.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={selected.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(i.id); else next.delete(i.id);
                      setSelected(next);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-mono text-sm text-slate-800">{i.code}</span>
                    <span className="ml-2 text-xs text-slate-500">{i.name}</span>
                    {/* Naming the current location is what stops a move being
                        accidental — the FK allows only one location per instrument. */}
                    {elsewhere && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[11px] font-semibold text-amber-800">
                        in {i.functionalLocationPath}
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </div>

          {moving.length > 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              {moving.length} instrument{moving.length === 1 ? '' : 's'} will be MOVED here from another location:{' '}
              {moving.map((i) => i.code).join(', ')}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setPickerOpen(false)} disabled={saving}>Cancel</Button>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </Dialog>
    </div>
  );
}
