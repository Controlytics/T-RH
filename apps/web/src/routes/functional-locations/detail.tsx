import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { LocationDialog, type LocationDraft } from './location-dialog';
import { InstrumentPanel } from './instrument-panel';
import type { FlNode } from './types';
import { Breadcrumbs } from '@/components/ui/page-header';

interface FlDetail {
  id: string;
  name: string;
  type: 'BLOCK' | 'AREA';
  parentId: string | null;
  ownCount: number;
  totalCount: number;
  children: FlNode[];
  instruments: { id: string; code: string; name: string; functionalLocationId: string | null }[];
}

function Stat({ value, label, hint }: { value: number; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white px-4 py-3">
      <p className="text-2xl font-bold tabular-nums text-slate-800">{value}</p>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

/**
 * One functional location: what it is, what sits under it, and which instruments
 * report from it.
 *
 * TWO instrument numbers appear here and they are NOT the same number for a Block
 * with Areas. `GET /:id` resolves the whole SCOPE (own + every Area's), which is
 * the authoritative "instruments in this Block". `InstrumentPanel` lists only the
 * DIRECT links, because it is the membership editor and `PUT /:id/instruments`
 * sets membership wholesale — showing an Area's instrument there would let an
 * unlink silently move it up to the Block. So the two are rendered as separate,
 * separately-labelled sections rather than one list.
 */
export function FunctionalLocationDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const can = useCan();
  const { toast } = useToast();

  const { data: treeData, mutate: mutateTree } = useSWR<{ data: FlNode[] }>('/api/functional-locations');
  const { data, error, isLoading, mutate } = useSWR<FlDetail>(
    id ? `/api/functional-locations/${id}` : null,
  );

  const [renameOpen, setRenameOpen] = useState(false);
  const [areaOpen, setAreaOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const tree = treeData?.data ?? [];
  const blocks = useMemo(() => tree.map((b) => ({ id: b.id, name: b.name })), [tree]);

  /**
   * `GET /:id` returns `parentId` but not the parent's NAME, so the path is
   * derived from the tree (already warm from the list page). Never render the
   * raw parentId here — that is how you end up with "cmf3k… > Cooling Area".
   */
  const parentName = useMemo(() => {
    if (!data?.parentId) return null;
    return tree.find((b) => b.id === data.parentId)?.name ?? null;
  }, [tree, data?.parentId]);

  const path = data ? (parentName ? `${parentName} > ${data.name}` : data.name) : '';

  /** Instruments held by this Block's Areas — read-only here; edited on the Area. */
  const inAreas = useMemo(() => {
    if (!data) return [];
    const areaName = new Map(data.children.map((c) => [c.id, c.name]));
    return data.instruments
      .filter((i) => i.functionalLocationId !== data.id)
      .map((i) => ({ ...i, areaName: areaName.get(i.functionalLocationId ?? '') ?? 'Unknown area' }))
      .sort((a, b) => a.areaName.localeCompare(b.areaName) || a.code.localeCompare(b.code));
  }, [data]);

  const refresh = async () => {
    await Promise.all([mutate(), mutateTree()]);
  };

  /**
   * Sends `parentId` as well as `name`. The dialog shows a "Belongs to Block"
   * picker for an Area, so a name-only PUT would let an operator change that
   * picker, get a success toast, and find the Area still under the old Block.
   * `PUT /:id` supports re-parenting and audits both paths.
   */
  const edit = async (draft: LocationDraft) => {
    const moved = draft.parentId !== (data?.parentId ?? null);
    await apiClient.put(`/api/functional-locations/${id}`, {
      name: draft.name,
      parentId: draft.parentId,
    });
    toast.success(
      'Location updated',
      moved ? `"${draft.name}" moved to another block.` : `Now "${draft.name}".`,
    );
    await refresh();
  };

  const createArea = async (draft: LocationDraft) => {
    await apiClient.post('/api/functional-locations', {
      name: draft.name,
      type: draft.type,
      parentId: draft.parentId,
    });
    toast.success('Area created', `"${draft.name}" added.`);
    await refresh();
  };

  const doDelete = async () => {
    try {
      await apiClient.delete(`/api/functional-locations/${id}`);
      toast.success('Location deleted', `"${data?.name ?? ''}" removed.`);
      await mutateTree();
      navigate('/functional-locations');
    } catch (e) {
      // The API refuses a non-empty location with a 409 naming the counts.
      // "still holds 3 instrument(s)" tells them what to do next; "delete
      // failed" does not.
      toast.error('Could not delete', (e as Error).message);
    } finally {
      setConfirmDelete(false);
    }
  };

  /** Before the record loads there is nothing to name it with. */
  const baseCrumbs = [
    { label: 'Home', to: '/' },
    { label: 'Functional Locations', to: '/functional-locations' },
  ];

  if (error) {
    return (
      <div className="space-y-4">
        <Breadcrumbs crumbs={baseCrumbs} />
        <Card className="px-6 py-14 text-center">
          <p className="text-base font-semibold text-slate-700">This functional location is not available</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            {(error as Error).message || 'It may have been deleted, or the link is wrong.'}
          </p>
        </Card>
      </div>
    );
  }

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <Breadcrumbs crumbs={baseCrumbs} />
        <div className="h-32 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-50" />
        <div className="h-48 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-50" />
      </div>
    );
  }

  const isBlock = data.type === 'BLOCK';

  return (
    <div className="space-y-5">
      <Breadcrumbs
        crumbs={[
          ...baseCrumbs,
          ...(parentName && data.parentId
            ? [{ label: parentName, to: `/functional-locations/${data.parentId}` }]
            : []),
          { label: data.name },
        ]}
      />

      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">{data.name}</h1>
              <Badge variant={isBlock ? 'default' : 'secondary'}>{data.type}</Badge>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {isBlock && can('functional_locations.create') && (
              <Button variant="outline" size="sm" onClick={() => setAreaOpen(true)}>
                Add area
              </Button>
            )}
            {can('functional_locations.edit') && (
              <Button variant="outline" size="sm" onClick={() => setRenameOpen(true)}>
                Edit
              </Button>
            )}
            {can('functional_locations.delete') && (
              <Button variant="destructive" size="sm" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
          </div>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <Stat
            value={data.totalCount}
            label="Instruments in total"
            hint={isBlock ? 'This block and all its areas' : 'Linked to this area'}
          />
          <Stat value={data.ownCount} label="Linked directly" hint="Edited below" />
          {isBlock && (
            <Stat
              value={data.children.length}
              label="Areas"
              hint={`${data.totalCount - data.ownCount} instrument(s) inside them`}
            />
          )}
        </div>
      </Card>

      {isBlock && (
        <Card className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-800">
            Areas <span className="font-normal text-slate-500">({data.children.length})</span>
          </h2>
          {data.children.length === 0 ? (
            <p className="text-sm text-slate-500">
              No areas in this block yet.
              {can('functional_locations.create') && ' Add one to group its instruments more finely.'}
            </p>
          ) : (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {data.children.map((a) => (
                <Link
                  key={a.id}
                  to={`/functional-locations/${a.id}`}
                  className="flex items-center justify-between gap-2 rounded-xl border border-slate-200 px-3 py-2.5 hover:border-slate-300 hover:bg-slate-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                >
                  <span className="min-w-0 truncate text-sm font-medium text-slate-800">{a.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-slate-500">
                    {a.ownCount} instrument{a.ownCount === 1 ? '' : 's'}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </Card>
      )}

      <InstrumentPanel
        locationId={data.id}
        locationPath={path}
        canEdit={can('functional_locations.edit')}
        onChanged={refresh}
      />

      {isBlock && inAreas.length > 0 && (
        <Card className="p-4">
          <h3 className="mb-1 text-sm font-semibold text-slate-800">
            Instruments in this block’s areas{' '}
            <span className="font-normal text-slate-500">({inAreas.length})</span>
          </h3>
          {/* Read-only on purpose: these belong to an Area, and membership is
              edited on the location that actually holds them. */}
          <p className="mb-3 text-xs text-slate-500">
            These count toward the block’s total. Open the area to change what belongs to it.
          </p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {inAreas.map((i) => (
              <div key={i.id} className="rounded-lg border border-slate-200 bg-slate-50/60 px-3 py-2">
                <p className="truncate font-mono text-sm font-medium text-slate-800">{i.code}</p>
                <p className="truncate text-xs text-slate-500">{i.name}</p>
                <p className="mt-0.5 truncate text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  {i.areaName}
                </p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <LocationDialog
        open={renameOpen}
        initial={{ id: data.id, name: data.name, type: data.type, parentId: data.parentId }}
        blocks={blocks}
        presetParentId={null}
        onClose={() => setRenameOpen(false)}
        onSubmit={edit}
      />

      <LocationDialog
        open={areaOpen}
        blocks={blocks}
        presetParentId={data.id}
        onClose={() => setAreaOpen(false)}
        onSubmit={createArea}
      />

      <ConfirmDialog
        open={confirmDelete}
        title="Delete functional location"
        message={`Delete "${data.name}"? This is refused if it still holds instruments or areas.`}
        confirmLabel="Delete"
        onConfirm={doDelete}
        onClose={() => setConfirmDelete(false)}
      />
    </div>
  );
}
