import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS } from '@digilog/shared';
import type { OverviewRow } from '@/routes/dashboard/use-telemetry';
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
 */
export interface HistoryScope {
  tree: LocationNode[];
  blockId: string;
  areaId: string;
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

  // Per-instrument keys, limits, precision and span — one request for the
  // whole plant.
  const { data: overviewData } = useSWR<{ data: OverviewRow[] }>('/api/instruments/telemetry-overview');
  const overviewById = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    for (const r of overviewData?.data ?? []) m.set(r.instrumentId, r);
    return m;
  }, [overviewData]);

  // A scope change resets the tick list: ticks from another Area must not
  // survive as hidden state. A chosen Block or Area starts with everything in
  // it selected; no scope starts with nothing.
  useEffect(() => { setSelected(scopeId ? null : new Set()); }, [scopeId]);

  const chosen = effectiveSelection(inScope, selected);

  return {
    tree, blockId, areaId,
    setBlock: (id) => { setBlockId(id); setAreaId(''); },
    setArea: setAreaId,
    areas, selected, setSelected, inScope, chosen, overviewById,
  };
}
