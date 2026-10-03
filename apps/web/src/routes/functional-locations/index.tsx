import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { themeGradient } from '@/lib/theme-styles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { PageHero } from '@/components/ui/page-hero';
import { LocationDialog, type LocationDraft } from './location-dialog';
import { ArrangeDialog } from './arrange-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { LocationGlyph } from './dialog-banner';
import { useDeleteLocation } from './delete-location';
import type { FlNode } from './types';

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
 * REDESIGNED 2026-09-17 (operator: "functional location page is looking sample
 * ui, i need best professional and colorful screen and inside screens also").
 * A themed hero band states the plant; each Block is a gradient plate with its
 * rolled-up count and its Areas listed on white beneath it. A live
 * reporting / silent split per location shipped for an hour and was removed
 * the same day (operator: "remove live status") — this page shows the
 * GROUPING and its counts, nothing about whether a device is talking.
 *
 * Everything that CHANGES a location lives on the detail page. This page reads
 * — except DELETE (2026-10-03, operator: "add delete option for functional
 * locations for super admin"): a trash button on each Block card and each Area
 * row, for a role holding the delete node; a super admin may delete a location
 * with everything in it (see `delete-location.tsx`).
 */
function TrashIcon() {
  return (
    <svg aria-hidden className="mr-1 h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
    </svg>
  );
}

/** The trash button beside an Area row. */
function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-rose-50 hover:text-rose-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500"
    >
      <svg aria-hidden className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
      </svg>
    </button>
  );
}

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

  // The backend gates every write on its reauth action (PUT /order on
  // UPDATE_FUNCTIONAL_LOCATION, the create on CREATE_FUNCTIONAL_LOCATION), so
  // the frontend has to be able to supply it or the save 401s with no way forward.
  const reauth = useReauth();
  const remove = useDeleteLocation(reauth, async () => { await mutate(); });

  const totalInstruments = useMemo(() => tree.reduce((sum, b) => sum + b.totalCount, 0), [tree]);
  const areaCount = useMemo(() => tree.reduce((sum, b) => sum + (b.children?.length ?? 0), 0), [tree]);

  const submit = async (draft: LocationDraft) => {
    const body = { name: draft.name, type: draft.type, parentId: draft.parentId };
    // Re-authenticated when the role requires it, like every other write here.
    await reauth.executeWithResult('CREATE_FUNCTIONAL_LOCATION', async (pw?: string) => (
      pw ? apiClient.postWithReauth('/api/functional-locations', body, pw) : apiClient.post('/api/functional-locations', body)
    ));
    toast.success('Location created', `"${draft.name}" added.`);
    await mutate();
  };

  const [arrangeOpen, setArrangeOpen] = useState(false);
  // Which block's AREAS are being arranged. null = the dialog is closed.
  // Holding the block id rather than a boolean means one dialog serves every
  // card, and it always knows whose siblings it is reordering.
  const [arrangeAreasOf, setArrangeAreasOf] = useState<string | null>(null);

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

  const actions = (
    <div className="flex flex-wrap items-center gap-2">
      {/* Arranging is an EDIT to these rows, so it is gated on the same
          permission as renaming them — and hidden entirely below two
          blocks, where there is no order to choose. */}
      {can('functional_locations.edit') && tree.length > 1 && (
        <Button
          variant="secondary"
          className="border-white/40 bg-white/15 text-white hover:bg-white/25"
          onClick={() => setArrangeOpen(true)}
        >
          Arrange order
        </Button>
      )}
      {can('functional_locations.create') && (
        <Button className="bg-white text-slate-900 shadow-[var(--elev-2)] hover:bg-white/90" onClick={() => setDialogOpen(true)}>
          Create functional location
        </Button>
      )}
    </div>
  );

  return (
    <div className="space-y-5">
      {/* The hero: where you are, what the plant holds, and how it is doing —
          the shared band since UI v3 (2026-09-21). */}
      <PageHero
        testId="fl-hero"
        title="Functional Locations"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Functional Locations' }]}
        icon={LocationGlyph}
        actions={actions}
        tiles={[
          { testId: 'fl-figure-blocks', value: tree.length, label: tree.length === 1 ? 'Block' : 'Blocks' },
          { testId: 'fl-figure-areas', value: areaCount, label: areaCount === 1 ? 'Area' : 'Areas' },
          { testId: 'fl-figure-instruments', value: totalInstruments, label: totalInstruments === 1 ? 'Instrument assigned' : 'Instruments assigned' },
        ]}
      >
        {tree.length > 0 && (
          <label className="block w-full md:max-w-md">
            <span className="mb-1.5 block text-[0.8125rem] font-medium text-white/85">Find a block or area</span>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search blocks and areas…"
              className="h-9 border-white/30 bg-white/90 text-slate-900 placeholder:text-slate-500"
            />
          </label>
        )}
      </PageHero>

      {isLoading && tree.length === 0 && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-48 animate-pulse rounded-[var(--radius-card)] border border-slate-200 bg-slate-50" />
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
          <Button variant="ghost" className="mt-2" type="button" onClick={() => setQuery('')}>
            Clear search
          </Button>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {visible.map((b) => {
          const areas = b.children ?? [];
          return (
            <Card key={b.id} data-testid={`fl-block-${b.name}`} className="flex flex-col overflow-hidden border-transparent">
              {/* The plate: the Block's name and its rolled-up count, on the
                  site's own colour so a Block reads as a Block from across the
                  room. Areas below it sit on white — the hierarchy is the tint. */}
              <Link
                to={`/functional-locations/${b.id}`}
                className="group relative block px-5 pb-4 pt-4 text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white"
                style={themeGradient}
              >
                <span aria-hidden className="pointer-events-none absolute -right-10 -top-14 h-40 w-40 rounded-full bg-white/10 blur-xl transition-transform duration-300 group-hover:scale-125" />
                <div className="relative flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <span className="inline-flex items-center rounded-[var(--radius-pill)] bg-white/20 px-2 py-0.5 text-[0.6875rem] font-semibold tracking-wide text-white ring-1 ring-inset ring-white/30">
                      Block
                    </span>
                    <h2 className="font-display mt-1.5 truncate text-[1.25rem] font-semibold leading-tight tracking-tight">
                      {b.name}
                    </h2>
                    {/* No "N linked directly · M areas" line under the name
                        (operator, 2026-09-17: "remove that linked directly line
                        also"). The plate carries the name and the total only;
                        the Areas are listed right below it. */}
                  </div>
                  <div className="shrink-0 text-right">
                    <span data-testid="fl-block-total" className="font-display block text-[2.25rem] font-bold leading-none tabular-nums">
                      {b.totalCount}
                    </span>
                    <span className="text-[0.6875rem] text-white/75">instrument{b.totalCount === 1 ? '' : 's'}</span>
                  </div>
                </div>
              </Link>

              {areas.length > 0 ? (
                <div className="mt-auto px-3 pb-3 pt-2">
                  <div className="flex items-center justify-between px-2 pb-1">
                    <span className="text-[0.75rem] font-semibold text-teal-800">Areas</span>
                    {/* Arranging Areas is per BLOCK, because Areas are siblings only
                        within their own Block. Shown from two Areas up — with one
                        there is no order to choose. */}
                    {can('functional_locations.edit') && areas.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="-mr-1 h-7 px-2 text-[0.75rem]"
                        onClick={() => setArrangeAreasOf(b.id)}
                        title={`Arrange the areas of ${b.name}`}
                      >
                        Arrange areas
                      </Button>
                    )}
                  </div>
                  <div className="space-y-1">
                    {areas.map((a) => (
                        // The row is a Link; the delete button sits BESIDE it,
                        // never inside it (a button inside an anchor is invalid
                        // and the click would navigate).
                        <div key={a.id} className="flex items-center gap-1">
                          <Link
                            to={`/functional-locations/${a.id}`}
                            className="group/area flex min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-2 hover:bg-teal-50/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-teal-600"
                          >
                            <span aria-hidden className="h-8 w-1 shrink-0 rounded-full bg-gradient-to-b from-teal-700 to-teal-500" />
                            <span className="min-w-0 flex-1 truncate text-[0.875rem] font-medium text-slate-800 group-hover/area:text-teal-900">{a.name}</span>
                            {/* ONE count per row (operator, 2026-09-17: "count is
                                showing two times for areas") — the pill carries
                                the word, so it is not a bare number. */}
                            <span className="inline-flex shrink-0 items-center rounded-[var(--radius-pill)] bg-teal-50 px-2 py-0.5 text-[0.75rem] font-semibold text-teal-800 ring-1 ring-inset ring-teal-600/20">
                              <span className="tabular-nums">{a.ownCount}</span>
                              {' '}
                              <span className="font-medium">instrument{a.ownCount === 1 ? '' : 's'}</span>
                            </span>
                          </Link>
                          {can('functional_locations.delete') && (
                            <DeleteButton label={`Delete area ${a.name}`} onClick={() => remove.request(a)} />
                          )}
                        </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="mt-auto px-5 py-3 text-xs text-slate-500">
                  No areas yet
                </p>
              )}
              {/* Delete the BLOCK: a quiet footer action, red only on hover —
                  the card is a place to browse, and a red button on every card
                  would shout over the counts. */}
              {can('functional_locations.delete') && (
                <div className="flex justify-end border-t border-slate-100 px-3 py-1.5">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-[0.75rem] text-slate-500 hover:bg-rose-50 hover:text-rose-700"
                    aria-label={`Delete block ${b.name}`}
                    onClick={() => remove.request(b)}
                  >
                    <TrashIcon /> Delete block
                  </Button>
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {remove.dialog}

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

/** One figure in the hero band: the number large, its word under it. */
