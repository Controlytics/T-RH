import useSWR from 'swr';

/**
 * Which FUNCTIONAL LOCATION a new instrument is born in — the New Instrument
 * form and Bulk Upload (2026-10-26).
 *
 * Why it exists: a user whose instrument view is limited to some locations
 * registered instruments with none, and lost sight of them the moment they were
 * created (AWS: every attribute typed into the form was refused 404). The server
 * now refuses that registration; this is how a limited user places it instead.
 *
 * Everything it offers is the SERVER's answer: `placeable` on each node of
 * `GET /api/functional-locations` and `placementRequired` beside them. Nothing
 * here works out a scope.
 *
 * Labelled "Functional location", not "Block" / "Area" alone: a profile may also
 * ask for free-text Block / Area ATTRIBUTES on the same form, which are a
 * different (superseded) thing.
 */

/** One node of the Block > Area tree, as the tree route serves it. */
export interface PlacementNode {
  id: string;
  name: string;
  /** May the caller register an instrument here and still see it? */
  placeable?: boolean;
  children?: PlacementNode[];
}

export interface Placement { blockId: string; areaId: string }
export const NO_PLACEMENT: Placement = { blockId: '', areaId: '' };

/** The location a selection places the instrument in, or '' for none. */
export function placedLocationId(tree: readonly PlacementNode[], p: Placement): string {
  if (p.areaId) return p.areaId;
  const block = tree.find((b) => b.id === p.blockId);
  return block?.placeable ? block.id : '';
}

export function usePlacementTree() {
  const { data } = useSWR<{ data: PlacementNode[]; placementRequired?: boolean }>('/api/functional-locations');
  return { tree: data?.data ?? [], required: data?.placementRequired === true };
}

export function LocationPicker({ tree, required, value, onChange, error }: {
  tree: readonly PlacementNode[];
  required: boolean;
  value: Placement;
  onChange: (next: Placement) => void;
  error?: string;
}) {
  // A Block is offered when it, or one of its Areas, may hold the instrument.
  const blocks = tree.filter((b) => b.placeable || b.children?.some((a) => a.placeable));
  const block = blocks.find((b) => b.id === value.blockId);
  const areas = block?.children?.filter((a) => a.placeable) ?? [];
  return (
    <fieldset className="space-y-1" data-testid="location-picker">
      <legend className="text-sm font-medium text-slate-700">Functional location{required ? ' *' : ''}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        <select
          aria-label="Functional location block"
          value={value.blockId}
          onChange={(e) => onChange({ blockId: e.target.value, areaId: '' })}
          className="ctl w-full"
        >
          <option value="">{required ? 'Select a block…' : 'None'}</option>
          {blocks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        <select
          aria-label="Functional location area"
          value={value.areaId}
          disabled={!block}
          onChange={(e) => onChange({ ...value, areaId: e.target.value })}
          className="ctl w-full"
        >
          {/* A Block the caller may not place in directly needs one of its Areas. */}
          <option value="">{!block || block.placeable ? 'The block itself' : 'Select an area…'}</option>
          {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </fieldset>
  );
}
