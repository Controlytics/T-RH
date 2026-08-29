import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { LocationDialog, type LocationDraft } from './location-dialog';
import { ArrangeDialog } from './arrange-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import type { FlNode } from './types';
import { PageHeader } from '@/components/ui/page-header';

/**
 * Functional Locations — the browse view: one card per BLOCK, its Areas listed
 * inside it.
 *
 * The grid is deliberately NOT flat. Block > Area is the whole model — a Block's
 * instruments are its own PLUS its Areas' — so a flat grid of every location
 * side by side would lose the one relationship the page exists to show, and make
 * "12 instruments" (a Block, rolled up) look like the same kind of number as
 * "3 instruments" (an Area, its own).
 *
 * Everything that CHANGES a location lives on the detail page. This page reads.
 */
export default function FunctionalLocationsPage() {
  const can = useCan();
  const { toast } = useToast();
  const { data, mutate, isLoading } = useSWR<{ data: FlNode[] }>('/api/functional-locations');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [query, setQuery] = useState('');

  const tree = data?.data ?? [];
  const blocks = useMemo(() => tree.map((b) => ({ id: b.id, name: b.name })), [tree]);

  /**
   * A Block stays in the results when an AREA inside it matches, otherwise
   * searching for an area name would return nothing — the areas are only
   * reachable through their Block's card.
   */
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return tree;
    return tree.filter(
      (b) =>
        b.name.toLowerCase().includes(q) ||
        (b.children ?? []).some((a) => a.name.toLowerCase().includes(q)),
    );
  }, [tree, query]);

  const totalInstruments = useMemo(
    () => tree.reduce((sum, b) => sum + b.totalCount, 0),
    [tree],
  );
  const areaCount = useMemo(
    () => tree.reduce((sum, b) => sum + (b.children?.length ?? 0), 0),
    [tree],
  );

  const submit = async (draft: LocationDraft) => {
    await apiClient.post('/api/functional-locations', {
      name: draft.name,
      type: draft.type,
      parentId: draft.parentId,
    });
    toast.success('Location created', `"${draft.name}" added.`);
    await mutate();
  };

  const [arrangeOpen, setArrangeOpen] = useState(false);
  // Which block's AREAS are being arranged. null = the dialog is closed.
  // Holding the block id rather than a boolean means one dialog serves every
  // card, and it always knows whose siblings it is reordering.
  const [arrangeAreasOf, setArrangeAreasOf] = useState<string | null>(null);
  // The backend gates PUT /order on UPDATE_FUNCTIONAL_LOCATION reauth, so the
  // frontend has to be able to supply it or the save 401s with no way forward.
  const reauth = useReauth();

  /**
   * Saves a manual sibling order — Blocks, or one Block's Areas.
   *
   * One handler for both because the endpoint takes one sibling set and does
   * not care which level it is: Blocks are siblings of each other, and a
   * Block's Areas are siblings of one another. Adding a second, near-identical
   * function for Areas would be two places to fix the next time this changes.
   *
   * Sends EVERY sibling, not just the ones that moved: the endpoint assigns
   * 1..N over the set it is given and rejects a partial list, because rows
   * left out would keep stale numbers and jump somewhere nobody chose the next
   * time the list rendered.
   */
  const saveOrder = async (ids: string[]) => {
    try {
      await reauth.execute('UPDATE_FUNCTIONAL_LOCATION', async (password?: string) => {
        if (password) {
          await apiClient.putWithReauth('/api/functional-locations/order', { ids }, password);
        } else {
          await apiClient.put('/api/functional-locations/order', { ids });
        }
      });
      toast.success('Order saved', 'They now appear in the order you chose.');
      await mutate();
    } catch (e: any) {
      toast.error('Could not save the order', e?.message ?? 'Please try again.');
      throw e;
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Functional Locations"
        description="Block and Area grouping. An instrument belongs to exactly one location."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Functional Locations' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 20l-5.447-2.724A1 1 0 013 16.382V5.618a1 1 0 011.447-.894L9 7m0 13l6-3m-6 3V7m6 10l4.553 2.276A1 1 0 0021 18.382V7.618a1 1 0 00-.553-.894L15 4m0 13V4m0 0L9 7" />
          </svg>
        }
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            {/* Arranging is an EDIT to these rows, so it is gated on the same
                permission as renaming them — and hidden entirely below two
                blocks, where there is no order to choose. */}
            {can('functional_locations.update') && tree.length > 1 && (
              <Button variant="outline" onClick={() => setArrangeOpen(true)}>
                Arrange order
              </Button>
            )}
            {can('functional_locations.create') && (
              <Button onClick={() => setDialogOpen(true)}>Create functional location</Button>
            )}
          </div>
        )}
      />

      {tree.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <div className="w-full sm:w-72">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search blocks and areas…"
            />
          </div>
          <p className="text-xs text-slate-500">
            {tree.length} block{tree.length === 1 ? '' : 's'} · {areaCount} area
            {areaCount === 1 ? '' : 's'} · {totalInstruments} instrument
            {totalInstruments === 1 ? '' : 's'} assigned
          </p>
        </div>
      )}

      {isLoading && tree.length === 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-40 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-50" />
          ))}
        </div>
      )}

      {!isLoading && tree.length === 0 && (
        <Card className="px-6 py-14 text-center">
          <p className="text-base font-semibold text-slate-700">No functional locations yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-slate-500">
            Create a Block for each building or production module, then add the Areas inside it.
            Instruments are then linked to whichever location they report from.
          </p>
          {can('functional_locations.create') && (
            <Button className="mt-5" onClick={() => setDialogOpen(true)}>
              Create the first Block
            </Button>
          )}
        </Card>
      )}

      {tree.length > 0 && visible.length === 0 && (
        <Card className="px-6 py-12 text-center">
          <p className="text-sm text-slate-600">
            Nothing matches “{query.trim()}”.
          </p>
          <Button variant="ghost" className="mt-2"
            type="button"
            onClick={() => setQuery('')}
          >
            Clear search
          </Button>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((b) => {
          const areas = b.children ?? [];
          return (
            <Card key={b.id} className="flex flex-col overflow-hidden">
              <Link
                to={`/functional-locations/${b.id}`}
                className="group block px-5 pb-4 pt-5 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="min-w-0 truncate text-lg font-semibold text-slate-800 group-hover:text-blue-700">
                    {b.name}
                  </h2>
                  <Badge className="shrink-0">BLOCK</Badge>
                </div>

                <div className="mt-3 flex items-baseline gap-2">
                  <span className="text-3xl font-bold tabular-nums text-slate-800">{b.totalCount}</span>
                  <span className="text-sm text-slate-500">
                    instrument{b.totalCount === 1 ? '' : 's'} in total
                  </span>
                </div>
                {/* "4 total, 1 here" is the difference between an empty Block and
                    one holding a corridor probe — the two must not look identical. */}
                <p className="mt-1 text-xs text-slate-500">
                  {b.ownCount} linked directly to the block · {areas.length} area
                  {areas.length === 1 ? '' : 's'}
                </p>
              </Link>

              {areas.length > 0 ? (
                <div className="mt-auto border-t border-slate-100 bg-slate-50/70 p-2">
                  {/* Arranging Areas is per BLOCK, because Areas are siblings only
                      within their own Block. Shown from two Areas up — with one
                      there is no order to choose. */}
                  {can('functional_locations.update') && areas.length > 1 && (
                    <div className="flex justify-end px-1 pb-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setArrangeAreasOf(b.id)}
                        title={`Arrange the areas of ${b.name}`}
                      >
                        Arrange areas
                      </Button>
                    </div>
                  )}
                  <div className="space-y-0.5">
                  {areas.map((a) => (
                    <Link
                      key={a.id}
                      to={`/functional-locations/${a.id}`}
                      className="flex items-center justify-between gap-2 rounded-lg px-3 py-1.5 hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      <span className="min-w-0 truncate text-sm text-slate-700">{a.name}</span>
                      <span className="shrink-0 text-xs tabular-nums text-slate-500">
                        {a.ownCount} instrument{a.ownCount === 1 ? '' : 's'}
                      </span>
                    </Link>
                  ))}
                  </div>
                </div>
              ) : (
                <p className="mt-auto border-t border-slate-100 bg-slate-50/70 px-5 py-3 text-xs text-slate-500">
                  No areas yet.
                </p>
              )}
            </Card>
          );
        })}
      </div>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Functional Locations"
      />

      {/* Areas of one Block. Keyed on the block id so React rebuilds the list
          when a different card is opened, rather than reusing the previous
          block's order state. */}
      {arrangeAreasOf && (() => {
        const block = tree.find((b) => b.id === arrangeAreasOf);
        if (!block) return null;
        return (
          <ArrangeDialog
            key={block.id}
            open
            onClose={() => setArrangeAreasOf(null)}
            title={`Arrange areas — ${block.name}`}
            items={(block.children ?? []).map((a) => ({
              id: a.id,
              name: a.name,
              meta: `${a.ownCount} instrument${a.ownCount === 1 ? '' : 's'}`,
            }))}
            onSave={saveOrder}
          />
        );
      })()}

      <ArrangeDialog
        open={arrangeOpen}
        onClose={() => setArrangeOpen(false)}
        title="Arrange blocks"
        items={tree.map((b) => ({
          id: b.id,
          name: b.name,
          meta: `${b.totalCount} instrument${b.totalCount === 1 ? '' : 's'}`,
        }))}
        onSave={saveOrder}
      />

      <LocationDialog
        open={dialogOpen}
        blocks={blocks}
        presetParentId={null}
        onClose={() => setDialogOpen(false)}
        onSubmit={submit}
      />
    </div>
  );
}
