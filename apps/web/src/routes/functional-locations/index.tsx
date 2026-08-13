import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LocationDialog, type LocationDraft } from './location-dialog';
import { InstrumentPanel } from './instrument-panel';

interface FlNode {
  id: string;
  name: string;
  type: 'BLOCK' | 'AREA';
  parentId: string | null;
  ownCount: number;
  totalCount: number;
  children?: FlNode[];
}

/**
 * Functional Locations — the Block > Area tree and its instrument links.
 *
 * Membership is edited HERE and nowhere else. The instrument form deliberately has
 * no location picker: two places to set one fact is how they end up disagreeing.
 *
 * A Block's count is its OWN instruments plus its Areas', which is why each Block
 * row shows both — "4 total, 1 here" is the difference between an empty Block and
 * one holding a corridor probe, and the two must not look identical.
 */
export default function FunctionalLocationsPage() {
  const can = useCan();
  const { toast } = useToast();
  const { data, mutate, isLoading } = useSWR<{ data: FlNode[] }>('/api/functional-locations');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<LocationDraft | undefined>();
  const [presetParent, setPresetParent] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<FlNode | null>(null);

  const tree = data?.data ?? [];
  const blocks = useMemo(() => tree.map((b) => ({ id: b.id, name: b.name })), [tree]);

  const flat = useMemo(() => {
    const out: { node: FlNode; path: string }[] = [];
    for (const b of tree) {
      out.push({ node: b, path: b.name });
      for (const a of b.children ?? []) out.push({ node: a, path: `${b.name} > ${a.name}` });
    }
    return out;
  }, [tree]);

  const selected = flat.find((f) => f.node.id === selectedId);

  const submit = async (draft: LocationDraft) => {
    if (draft.id) {
      await apiClient.put(`/api/functional-locations/${draft.id}`, { name: draft.name });
      toast.success('Location renamed', `Now "${draft.name}".`);
    } else {
      await apiClient.post('/api/functional-locations', {
        name: draft.name, type: draft.type, parentId: draft.parentId,
      });
      toast.success('Location created', `"${draft.name}" added.`);
    }
    await mutate();
  };

  const doDelete = async () => {
    if (!confirmDelete) return;
    try {
      await apiClient.delete(`/api/functional-locations/${confirmDelete.id}`);
      toast.success('Location deleted', `"${confirmDelete.name}" removed.`);
      if (selectedId === confirmDelete.id) setSelectedId(null);
      await mutate();
    } catch (e) {
      // The API refuses a non-empty location with a 409 naming the counts. Show
      // that message: "still holds 3 instrument(s)" tells them what to do next,
      // where "delete failed" does not.
      toast.error('Could not delete', (e as Error).message);
    } finally {
      setConfirmDelete(null);
    }
  };

  const Row = ({ node, path, indent }: { node: FlNode; path: string; indent: boolean }) => (
    <div
      className={`flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3 last:border-0 ${
        selectedId === node.id ? 'bg-slate-50' : 'hover:bg-slate-50/60'
      } ${indent ? 'pl-12' : ''}`}
    >
      <button type="button" onClick={() => setSelectedId(node.id)} className="min-w-0 flex-1 text-left">
        <span className="font-semibold text-slate-800">{node.name}</span>
        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-600">
          {node.type}
        </span>
        <span className="ml-2 text-xs text-slate-500">
          {node.type === 'BLOCK'
            ? `${node.totalCount} instrument${node.totalCount === 1 ? '' : 's'} total · ${node.ownCount} here`
            : `${node.ownCount} instrument${node.ownCount === 1 ? '' : 's'}`}
        </span>
      </button>

      <div className="flex shrink-0 items-center gap-1">
        {node.type === 'BLOCK' && can('functional_locations.create') && (
          <button
            type="button"
            onClick={() => { setEditing(undefined); setPresetParent(node.id); setDialogOpen(true); }}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
          >
            + Area
          </button>
        )}
        {can('functional_locations.edit') && (
          <button
            type="button"
            onClick={() => {
              setEditing({ id: node.id, name: node.name, type: node.type, parentId: node.parentId });
              setPresetParent(null);
              setDialogOpen(true);
            }}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-slate-600 hover:bg-slate-100"
          >
            Rename
          </button>
        )}
        {can('functional_locations.delete') && (
          <button
            type="button"
            onClick={() => setConfirmDelete(node)}
            className="rounded-lg px-2 py-1 text-xs font-semibold text-red-600 hover:bg-red-50"
          >
            Delete
          </button>
        )}
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Functional Locations</h1>
          <p className="mt-1 text-sm text-slate-600">
            Block and Area grouping. An instrument belongs to one location.
          </p>
        </div>
        {can('functional_locations.create') && (
          <Button onClick={() => { setEditing(undefined); setPresetParent(null); setDialogOpen(true); }}>
            Create functional location
          </Button>
        )}
      </div>

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-soft">
        {isLoading && tree.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-500">Loading…</p>
        )}
        {!isLoading && tree.length === 0 && (
          <p className="px-4 py-10 text-center text-sm text-slate-500">
            No functional locations yet. Create a Block to begin.
          </p>
        )}
        {tree.map((b) => (
          <div key={b.id}>
            <Row node={b} path={b.name} indent={false} />
            {(b.children ?? []).map((a) => (
              <Row key={a.id} node={a} path={`${b.name} > ${a.name}`} indent />
            ))}
          </div>
        ))}
      </div>

      {selected && (
        <InstrumentPanel
          locationId={selected.node.id}
          locationPath={selected.path}
          canEdit={can('functional_locations.edit')}
          onChanged={() => mutate()}
        />
      )}

      <LocationDialog
        open={dialogOpen}
        initial={editing}
        blocks={blocks}
        presetParentId={presetParent}
        onClose={() => setDialogOpen(false)}
        onSubmit={submit}
      />

      <ConfirmDialog
        open={Boolean(confirmDelete)}
        title="Delete functional location"
        message={
          confirmDelete
            ? `Delete "${confirmDelete.name}"? This is refused if it still holds instruments or areas.`
            : ''
        }
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setConfirmDelete(null)}
      />
    </div>
  );
}
