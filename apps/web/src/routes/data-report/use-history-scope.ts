import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS } from '@digilog/shared';
import { useTelemetryOverview, type OverviewRow } from '@/routes/dashboard/use-telemetry';
import {
  scopeIdFor, areasOf, effectiveSelection,
  type LocationNode, type ScopedInstrument,
} from '@/routes/instruments/history-selection';

/**
 * The Data Report page's SELECTION — Block, Area, and the tick list of the
 * instruments in scope — plus the per-instrument facts both consumers need.
 *
 * Lifted out of the history widget on 2026-09-07 because two things on the
 * page read it: the widget (which renders the controls and the readings of
 * the selection) and the Generate Data Report card (which downloads the report
 * FOR that selection). One owner, or the card could report a set the table is
 * not showing. The pure rules live in `history-selection.ts`; this hook only
 * holds the state and the three requests.
 *
 * A scope change resets the selection IN THE HANDLER, synchronously — not in an
 * effect on `scopeId` (review, 2026-09-07). An effect commits one render with
 * the previous scope's ticks, which fires the merged-history query for a set
 * the operator has just left; and it cannot tell the widget to reset its page
 * when the selection stays `null` across two Blocks, so page 3's offset went
 * to the new scope. `scopeId` is exposed so the widget keys its page reset on
 * the scope itself.
 */
export interface HistoryScope {
  tree: LocationNode[];
  blockId: string;
  areaId: string;
  /** The Area, else the Block, else `null` — what the list route is asked for. */
  scopeId: string | null;
  setBlock: (id: string) => void;
  setArea: (id: string) => void;
  /** The chosen Block's Areas. */
  areas: LocationNode[];
  /** `null` = everything in scope; a Set = those ids (see `history-selection.ts`). */
  selected: Set<string> | null;
  setSelected: (next: Set<string> | null) => void;
  /** Every instrument in scope — the LIST route's answer, visibility applied. */
  inScope: ScopedInstrument[];
  /** The effective selection, in scope order. */
  chosen: ScopedInstrument[];
  /** Keys, limits, precision and span per instrument — the server's resolution. */
  overviewById: Map<string, OverviewRow>;
}

export function useHistoryScope(): HistoryScope {
  const [blockId, setBlockId] = useState('');
  const [areaId, setAreaId] = useState('');
  // NOTHING is selected until a Block or Area is chosen (then everything in
  // it is). With no scope the list is the whole plant, and "everything
  // selected by default" would fire a plant-wide history query for every
  // visitor of the page.
  const [selected, setSelected] = useState<Set<string> | null>(new Set());

  const { data: treeData } = useSWR<{ data: LocationNode[] }>('/api/functional-locations');
  const tree = useMemo(() => treeData?.data ?? [], [treeData]);
  const areas = areasOf(tree, blockId);

  // The instruments in scope, from the list route — which applies the caller's
  // visibility and expands a Block to its Areas. Ask for every record: this
  // list is a picker, and a picker that shows page one of an Area is a picker
  // that silently omits the rest.
  const scopeId = scopeIdFor(blockId, areaId);
  const instQs = new URLSearchParams({ limit: String(ALL_RECORDS) });
  if (scopeId) instQs.set('functionalLocationId', scopeId);
  const { data: instData } = useSWR<{ data: ScopedInstrument[] }>(`/api/instruments?${instQs}`);
  const inScope = useMemo(() => instData?.data ?? [], [instData]);

  // Per-instrument keys, limits, precision and span — the dashboard's own hook,
  // which polls on the administered interval and revalidates on focus. A bare
  // `useSWR` here fetched once, so a limit changed while this page stayed open
  // would have been frozen, stale, into a signed document.
  const { rows: overviewRows } = useTelemetryOverview();
  const overviewById = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    for (const r of overviewRows) m.set(r.instrumentId, r);
    return m;
  }, [overviewRows]);

  const chosen = effectiveSelection(inScope, selected);

  // A chosen Block or Area starts with everything in it selected; no scope
  // starts with nothing. Set with the scope, in the same render.
  const setBlock = (id: string) => { setBlockId(id); setAreaId(''); setSelected(id ? null : new Set()); };
  const setArea = (id: string) => { setAreaId(id); setSelected(scopeIdFor(blockId, id) ? null : new Set()); };

  return {
    tree, blockId, areaId, scopeId,
    setBlock, setArea,
    areas, selected, setSelected, inScope, chosen, overviewById,
  };
}
