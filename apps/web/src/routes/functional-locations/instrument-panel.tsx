import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { InstrumentTile } from './instrument-tile';
import { DialogBanner } from './dialog-banner';

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
    <section data-testid="fl-instruments" className="rounded-[var(--radius-card)] border border-slate-200/60 bg-white shadow-soft">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span aria-hidden className="h-6 w-1 rounded-full" style={{ background: 'linear-gradient(to bottom, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
          <h3 className="text-[0.9375rem] font-semibold text-slate-900">
            Instruments in {locationPath}
          </h3>
          <span className="inline-flex min-w-[1.75rem] justify-center rounded-[var(--radius-pill)] px-2 py-0.5 text-[0.75rem] font-semibold tabular-nums text-[var(--theme-primary,#2a78d6)] ring-1 ring-inset ring-[var(--theme-primary,#2a78d6)]/25" style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary, #2a78d6) 10%, white)' }}>
            {linked.length}
          </span>
        </div>
        {canEdit && <Button size="sm" onClick={() => setPickerOpen(true)}>Add instruments</Button>}
      </div>

      <div className="p-4">
        {linked.length === 0 ? (
          <p className="rounded-[var(--radius-card)] border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
            No instruments linked yet.{canEdit && ' Choose Add instruments to link the ones that report from here.'}
          </p>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {linked.map((i) => (
              <InstrumentTile
                key={i.id}
                id={i.id}
                code={i.code}
                name={i.name}
                action={canEdit ? (
                  <Button variant="ghost" size="sm" type="button" className="h-7 px-2 text-[0.75rem]" onClick={() => unlink(i)}>
                    Unlink
                  </Button>
                ) : undefined}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={pickerOpen} onClose={() => setPickerOpen(false)}>
        <DialogBanner title="Add instruments" subtitle={locationPath} />
        <div className="space-y-3">
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by ID or name…" />

          <div className="max-h-72 space-y-1 overflow-y-auto">
            {candidates.map((i) => {
              const elsewhere = i.functionalLocationId && i.functionalLocationId !== locationId;
              return (
                <label key={i.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    className="ctl-check mt-1"
                    checked={selected.has(i.id)}
                    onChange={(e) => {
                      const next = new Set(selected);
                      if (e.target.checked) next.add(i.id); else next.delete(i.id);
                      setSelected(next);
                    }}
                  />
                  <span className="min-w-0">
                    <span className="font-mono text-sm text-slate-800">{i.code}</span>
                    {i.name !== i.code && <span className="ml-2 text-xs text-slate-500">{i.name}</span>}
                    {/* Naming the current location is what stops a move being
                        accidental — the FK allows only one location per instrument. */}
                    {elsewhere && (
                      <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[0.6875rem] font-semibold text-amber-800">
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
    </section>
  );
}
