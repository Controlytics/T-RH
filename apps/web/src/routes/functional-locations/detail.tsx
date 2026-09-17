import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { themeGradient } from '@/lib/theme-styles';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Breadcrumbs } from '@/components/ui/page-header';
import { LocationDialog, type LocationDraft } from './location-dialog';
import { InstrumentPanel } from './instrument-panel';
import { InstrumentTile } from './instrument-tile';
import { LocationGlyph } from './dialog-banner';
import type { FlNode } from './types';

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

/** One figure inside the hero band. */
function Stat({ value, label, hint, testId }: { value: number; label: string; hint?: string; testId: string }) {
  return (
    <div data-testid={testId} className="rounded-[var(--radius-card)] bg-white/12 px-4 py-3 ring-1 ring-inset ring-white/20 backdrop-blur-sm">
      <p className="font-display text-[1.75rem] font-bold leading-none tabular-nums">{value}</p>
      <p className="mt-1 text-[0.8125rem] font-medium text-white/90">{label}</p>
      {hint && <p className="mt-0.5 text-[0.6875rem] text-white/65">{hint}</p>}
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
 *
 * REDESIGNED 2026-09-17 with the list page ("and inside screens also"): the
 * header is a themed band holding the figures; Areas are teal tiles, the
 * dashboard's location hue; instruments are code tiles. No live state per
 * instrument (operator, same day: "remove live status").
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
        <div className="h-44 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-50" />
        <div className="h-48 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-50" />
      </div>
    );
  }

  const isBlock = data.type === 'BLOCK';
  const white = 'border-white/40 bg-white/15 text-white hover:bg-white/25';

  return (
    <div className="space-y-5">
      <section
        data-testid="fl-detail-hero"
        className="relative overflow-hidden rounded-[var(--radius-card)] p-6 text-white shadow-[var(--elev-3)]"
        style={themeGradient}
      >
        <span aria-hidden className="pointer-events-none absolute -right-16 -top-24 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
        <span aria-hidden className="pointer-events-none absolute -bottom-28 left-1/3 h-64 w-64 rounded-full bg-black/10 blur-3xl" />
        <div className="relative space-y-5">
          <Breadcrumbs
            inverted
            crumbs={[
              ...baseCrumbs,
              ...(parentName && data.parentId
                ? [{ label: parentName, to: `/functional-locations/${data.parentId}` }]
                : []),
              { label: data.name },
            ]}
          />

          <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
            <div className="flex min-w-0 items-start gap-3.5">
              <span aria-hidden className="mt-0.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-card)] bg-white/20 text-white backdrop-blur-sm">
                {LocationGlyph}
              </span>
              <div className="min-w-0">
                <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-white/20 px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-white ring-1 ring-inset ring-white/30">
                  {isBlock ? 'Block' : 'Area'}
                </span>
                <h1 className="font-display mt-1 text-[1.75rem] font-semibold leading-tight tracking-tight">{data.name}</h1>
                {parentName && <p className="mt-0.5 text-[0.8125rem] text-white/75">Inside {parentName}</p>}
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {isBlock && can('functional_locations.create') && (
                <Button variant="secondary" size="sm" className={white} onClick={() => setAreaOpen(true)}>
                  Add area
                </Button>
              )}
              {can('functional_locations.edit') && (
                <Button variant="secondary" size="sm" className={white} onClick={() => setRenameOpen(true)}>
                  Edit
                </Button>
              )}
              {can('functional_locations.delete') && (
                <Button variant="secondary" size="sm" className="border-rose-200/60 bg-rose-500/30 text-white hover:bg-rose-500/45" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
              )}
            </div>
          </div>

          {/* Two figures on a Block, one on an Area. There is no "Linked
              directly" tile (operator, 2026-09-17: "remove that linked directly
              tile also") — the direct list below is that number, counted. */}
          <div className={`grid gap-3 ${isBlock ? 'sm:grid-cols-2 md:max-w-lg' : 'md:max-w-xs'}`}>
            <Stat
              testId="fl-stat-total"
              value={data.totalCount}
              label="Instruments in total"
              hint={isBlock ? 'This block and all its areas' : 'Linked to this area'}
            />
            {isBlock && (
              <Stat
                testId="fl-stat-areas"
                value={data.children.length}
                label={data.children.length === 1 ? 'Area' : 'Areas'}
                hint={`${data.totalCount - data.ownCount} instrument${data.totalCount - data.ownCount === 1 ? '' : 's'} inside them`}
              />
            )}
          </div>
        </div>
      </section>

      {isBlock && (
        <section data-testid="fl-areas" className="rounded-[var(--radius-card)] border border-slate-200/60 bg-white shadow-soft">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="h-6 w-1 rounded-full bg-gradient-to-b from-teal-700 to-teal-500" />
              <h2 className="text-[0.9375rem] font-semibold text-slate-900">Areas</h2>
              <span className="inline-flex min-w-[1.75rem] justify-center rounded-[var(--radius-pill)] bg-teal-50 px-2 py-0.5 text-[0.75rem] font-semibold tabular-nums text-teal-800 ring-1 ring-inset ring-teal-600/20">
                {data.children.length}
              </span>
            </div>
          </div>
          <div className="p-4">
            {data.children.length === 0 ? (
              <p className="rounded-[var(--radius-card)] border border-dashed border-slate-300 px-4 py-6 text-center text-sm text-slate-500">
                No areas in this block yet.
                {can('functional_locations.create') && ' Choose Add area to group its instruments more finely.'}
              </p>
            ) : (
              <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                {data.children.map((a) => (
                    <Link
                      key={a.id}
                      to={`/functional-locations/${a.id}`}
                      className="group relative flex items-center gap-3 overflow-hidden rounded-[var(--radius-card)] border border-teal-600/15 bg-gradient-to-br from-teal-50 to-white py-3 pl-4 pr-3 shadow-[var(--elev-1)] transition-colors hover:border-teal-600/40 hover:from-teal-100/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                    >
                      <span aria-hidden className="absolute inset-y-0 left-0 w-1 bg-gradient-to-b from-teal-700 to-teal-500" />
                      <span className="min-w-0 flex-1 truncate text-[0.9375rem] font-semibold text-slate-900 group-hover:text-teal-900">{a.name}</span>
                      {/* ONE count per tile (operator, 2026-09-17: "count is
                          showing two times for areas"). */}
                      <span className="inline-flex shrink-0 items-center rounded-[var(--radius-pill)] bg-white px-2 py-0.5 text-[0.75rem] font-semibold text-teal-800 ring-1 ring-inset ring-teal-600/25">
                        <span className="tabular-nums">{a.ownCount}</span>
                        {' '}
                        <span className="font-medium">instrument{a.ownCount === 1 ? '' : 's'}</span>
                      </span>
                      <svg aria-hidden className="h-4 w-4 shrink-0 text-teal-700/60 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </Link>
                ))}
              </div>
            )}
          </div>
        </section>
      )}

      <InstrumentPanel
        locationId={data.id}
        locationPath={path}
        canEdit={can('functional_locations.edit')}
        onChanged={refresh}
      />

      {isBlock && inAreas.length > 0 && (
        <section data-testid="fl-in-areas" className="rounded-[var(--radius-card)] border border-slate-200/60 bg-white shadow-soft">
          <div className="border-b border-slate-100 px-5 py-3.5">
            <div className="flex items-center gap-2.5">
              <span aria-hidden className="h-6 w-1 rounded-full bg-gradient-to-b from-teal-700 to-teal-500" />
              <h3 className="text-[0.9375rem] font-semibold text-slate-900">Instruments in this block’s areas</h3>
              <span className="inline-flex min-w-[1.75rem] justify-center rounded-[var(--radius-pill)] bg-teal-50 px-2 py-0.5 text-[0.75rem] font-semibold tabular-nums text-teal-800 ring-1 ring-inset ring-teal-600/20">
                {inAreas.length}
              </span>
            </div>
            {/* Read-only on purpose: these belong to an Area, and membership is
                edited on the location that actually holds them. */}
            <p className="mt-1 text-xs text-slate-500">
              These count toward the block’s total. Open the area to change what belongs to it.
            </p>
          </div>
          <div className="grid gap-2.5 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {inAreas.map((i) => (
              <InstrumentTile key={i.id} id={i.id} code={i.code} name={i.name} tag={i.areaName} />
            ))}
          </div>
        </section>
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
