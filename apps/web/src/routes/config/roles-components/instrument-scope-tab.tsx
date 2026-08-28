import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';

interface FlNode {
  id: string;
  name: string;
  type: 'BLOCK' | 'AREA';
  ownCount: number;
  totalCount: number;
  children: FlNode[];
}

interface PickerInstrument {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  functionalLocationId: string | null;
  functionalLocationName: string | null;
  /**
   * Which locations already grant this instrument — its own Area AND that Area's
   * Block. Computed SERVER-SIDE from the same `resolveLocationIds` the query uses
   * and shipped here; the browser must not re-derive containment from the tree.
   */
  coveringLocationIds: string[];
}

/**
 * A scope as the API carries it. `null` is the third state and lives outside this
 * shape — see the header comment below.
 */
interface Scope {
  locationIds: string[];
  instrumentIds: string[];
}

interface RoleScope { role: string; scope: Scope | null }
interface UserScope { userId: string; username: string; fullName: string | null; role: string; scope: Scope | null }

interface FlatNode { node: FlNode; depth: number }

const EMPTY: Scope = { locationIds: [], instrumentIds: [] };
const isEmpty = (s: Scope) => s.locationIds.length === 0 && s.instrumentIds.length === 0;

/** Add or remove one id, without caring which list it came from. */
const toggle = (list: string[], id: string, on: boolean) =>
  on ? [...list, id] : list.filter((v) => v !== id);

/**
 * Functional locations. Ticking a Block grants its Areas — stated on screen rather
 * than left to be discovered.
 */
function LocationPicker({
  flat, value, onChange,
}: { flat: FlatNode[]; value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">By location</p>
      {flat.length === 0 && (
        <p className="text-xs text-slate-500">
          No functional locations exist yet — create them on the Functional Locations page.
        </p>
      )}
      {flat.map(({ node, depth }) => (
        <label key={node.id} className={`flex items-center gap-2 text-sm ${depth ? 'pl-6' : 'font-medium'}`}>
          <input
            type="checkbox"
            checked={value.includes(node.id)}
            onChange={(e) => onChange(toggle(value, node.id, e.target.checked))}
          className="ctl-check" />
          <span>{node.name}</span>
          <span className="text-xs text-slate-500">
            {node.type === 'BLOCK' ? `Block · ${node.totalCount} incl. areas` : `Area · ${node.ownCount}`}
          </span>
        </label>
      ))}
      {flat.some((f) => f.depth === 0) && (
        <p className="pt-1 text-[11px] text-slate-500">
          Selecting a Block also grants its Areas.
        </p>
      )}
    </div>
  );
}

/**
 * Individual instruments, searchable because a plant has more of them than fit on a
 * screen. Filtering is display-only: a ticked instrument that the current search
 * hides stays ticked, and the counts above the box are over the WHOLE list, so a
 * filtered view can never read as an empty selection.
 *
 * An instrument already covered by a selected location renders ticked, disabled and
 * labelled "via <location>". Without this the screen looked like nothing had been
 * assigned when a Block had in fact granted a hundred instruments — the assignment
 * was correct and invisible, which is the worst combination on an access-control
 * screen. It cannot be unticked individually: the LOCATION grants it, so removing
 * one would mean deselecting the location.
 */
function InstrumentPicker({
  instruments, value, selectedLocationIds, locationNameOf, onChange,
}: {
  instruments: PickerInstrument[];
  value: string[];
  selectedLocationIds: string[];
  locationNameOf: (id: string) => string;
  onChange: (next: string[]) => void;
}) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  /** The selected location that covers this instrument, or null. */
  const coveredBy = (i: PickerInstrument) =>
    i.coveringLocationIds.find((id) => selectedLocationIds.includes(id)) ?? null;

  const coveredCount = instruments.filter((i) => coveredBy(i) !== null).length;

  const shown = needle
    ? instruments.filter((i) =>
      i.code.toLowerCase().includes(needle) ||
      i.name.toLowerCase().includes(needle) ||
      (i.functionalLocationName ?? '').toLowerCase().includes(needle))
    : instruments;

  return (
    <div className="mt-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">By instrument</p>
        <span className="text-xs text-slate-500">{value.length} picked individually</span>
        <input
          className="ctl ctl-sm ml-auto w-44"
          placeholder="Search code, name, location"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      {coveredCount > 0 && (
        <p className="mb-2 rounded-md border border-sky-200 bg-sky-50 px-2 py-1.5 text-xs text-sky-800">
          <strong>{coveredCount}</strong> instrument{coveredCount === 1 ? '' : 's'} already included by the
          selected location{selectedLocationIds.length === 1 ? '' : 's'}. Selecting a Block includes every
          instrument in its Areas.
        </p>
      )}
      {instruments.length === 0 && (
        <p className="text-xs text-slate-500">No instruments exist yet.</p>
      )}
      {instruments.length > 0 && shown.length === 0 && (
        <p className="text-xs text-slate-500">Nothing matches “{q}”.</p>
      )}
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {shown.map((i) => {
          const via = coveredBy(i);
          return (
            <label
              key={i.id}
              className={`flex items-center gap-2 text-sm ${via ? 'text-slate-500' : ''}`}
              title={via ? `Included by the selected location “${locationNameOf(via)}”` : undefined}
            >
              <input
                type="checkbox"
                checked={via !== null || value.includes(i.id)}
                disabled={via !== null}
                onChange={(e) => onChange(toggle(value, i.id, e.target.checked))}
              className="ctl-check" />
              <span className="font-medium">{i.code}</span>
              <span className="truncate">{i.name}</span>
              {via ? (
                <span className="ml-auto shrink-0 rounded bg-sky-100 px-1.5 py-0.5 text-[10px] font-semibold text-sky-700">
                  via {locationNameOf(via)}
                </span>
              ) : (
                <span className="ml-auto shrink-0 text-xs text-slate-500">
                  {i.functionalLocationName ?? 'no location'}
                </span>
              )}
              {!i.isActive && (
                <span className="shrink-0 rounded bg-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600">
                  inactive
                </span>
              )}
            </label>
          );
        })}
      </div>
      <p className="pt-1 text-[11px] text-slate-500">
        An instrument picked here is visible even if it has not been placed in a Block or Area yet.
      </p>
    </div>
  );
}

/**
 * The three-state editor. Declared at module scope, NOT inside the tab component:
 * a component defined during render is a new type on every render, so React
 * unmounts and remounts it — which silently discarded a half-finished selection
 * whenever SWR revalidated (on window focus, for instance) or another row saved.
 */
function ScopeEditor({
  busy, current, inheritFrom, flat, instruments, locationNameOf, onSave,
}: {
  busy: boolean;
  current: Scope | null;
  inheritFrom?: string | null;
  flat: FlatNode[];
  instruments: PickerInstrument[];
  locationNameOf: (id: string) => string;
  onSave: (s: Scope | null) => void;
}) {
  const [limited, setLimited] = useState(current !== null);
  const [picked, setPicked] = useState<Scope>(current ?? EMPTY);
  const unlimitedLabel = inheritFrom !== undefined ? 'Inherit role' : 'All instruments';

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={!limited} onChange={() => setLimited(false)} className="ctl-radio" />
          <span>{unlimitedLabel}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={limited} onChange={() => setLimited(true)} className="ctl-radio" />
          <span>Only what I select</span>
        </label>
        <Button className="ml-auto" disabled={busy} onClick={() => onSave(limited ? picked : null)}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {limited && (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            <LocationPicker
              flat={flat}
              value={picked.locationIds}
              onChange={(locationIds) => setPicked((p) => ({ ...p, locationIds }))}
            />
            <InstrumentPicker
              instruments={instruments}
              value={picked.instrumentIds}
              selectedLocationIds={picked.locationIds}
              locationNameOf={locationNameOf}
              onChange={(instrumentIds) => setPicked((p) => ({ ...p, instrumentIds }))}
            />
          </div>
          <p className="mt-2 text-[11px] text-slate-500">
            The two lists ADD UP — an instrument is visible if it sits in a selected location
            <em> or </em> is selected by name.
          </p>
        </>
      )}
      {limited && isEmpty(picked) && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Nothing selected — this will show <strong>no instruments at all</strong>. Choose
          “{unlimitedLabel}” instead if that is not what you mean.
        </p>
      )}
    </div>
  );
}

/**
 * Instrument visibility scope, per role and per user.
 *
 * THREE STATES, and the UI must keep them distinguishable because collapsing them
 * turns a deny into a grant:
 *   null                      — inherit (user → role → all instruments)
 *   {locations:[], instr:[]}  — SEE NOTHING
 *   anything selected         — those locations (Blocks include their Areas) PLUS
 *                               those instruments, as a union
 *
 * "All instruments" writes null. "Only what I select" with nothing ticked writes an
 * empty selection and the UI says so out loud, because that is a real instruction
 * someone may not have meant.
 *
 * A user override REPLACES the role's scope and can therefore WIDEN it. The role's
 * current setting is named beside every override so nobody widens by accident.
 */
export function InstrumentScopeTab() {
  const { toast } = useToast();
  const { data: tree } = useSWR<{ data: FlNode[] }>('/api/functional-locations');
  // Deliberately the UNSCOPED admin listing, not /api/instruments: an admin who is
  // themselves scoped would otherwise build a scope from half the plant and not know.
  const { data: instrumentList } = useSWR<{ data: PickerInstrument[] }>('/api/roles/instrument-scope/instruments');
  const { data, mutate } = useSWR<{ roles: RoleScope[]; users: UserScope[] }>('/api/roles/instrument-scope');
  const [saving, setSaving] = useState<string | null>(null);

  const locations = tree?.data ?? [];
  const instruments = useMemo(() => instrumentList?.data ?? [], [instrumentList]);
  const flat = useMemo<FlatNode[]>(
    () => locations.flatMap((b) => [{ node: b, depth: 0 }, ...b.children.map((c) => ({ node: c, depth: 1 }))]),
    [locations],
  );

  const nameOfLocation = (id: string) => flat.find((f) => f.node.id === id)?.node.name ?? '(deleted location)';
  const nameOfInstrument = (id: string) => instruments.find((i) => i.id === id)?.code ?? '(deleted instrument)';

  const describe = (scope: Scope | null, inheritFrom?: string | null) => {
    if (scope === null) {
      return inheritFrom !== undefined
        ? `Inherits role${inheritFrom ? ` (${inheritFrom})` : ''}`
        : 'All instruments';
    }
    if (isEmpty(scope)) return 'Sees nothing';
    return [
      ...scope.locationIds.map(nameOfLocation),
      ...scope.instrumentIds.map(nameOfInstrument),
    ].join(', ');
  };

  const save = async (kind: 'role' | 'user', key: string, scope: Scope | null) => {
    setSaving(`${kind}:${key}`);
    try {
      await apiClient.put(`/api/roles/instrument-scope/${kind}/${encodeURIComponent(key)}`, { scope });
      toast.success('Visibility updated', scope === null
        ? (kind === 'role' ? 'Sees all instruments.' : 'Now inherits the role.')
        : isEmpty(scope) ? 'Sees no instruments.'
          : `Limited to ${scope.locationIds.length} location(s) and ${scope.instrumentIds.length} instrument(s).`);
      await mutate();
    } catch (e) {
      toast.error('Could not save', (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold text-slate-800">Per role</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          Super Admin always sees everything and is not listed.
        </p>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {(data?.roles ?? []).filter((r) => r.role !== 'SUPER_ADMIN').map((r) => (
            <div key={r.role} className="p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-slate-800">{r.role}</span>
                <span className="text-xs text-slate-500">currently: {describe(r.scope)}</span>
              </div>
              <ScopeEditor
                // Re-seeds the editor's local state from the server value, and ONLY
                // when that value actually changes. Without it a saved row would keep
                // showing the pre-save selection; with a broader key it would discard
                // a half-finished one on any revalidation, which is the bug that
                // hoisting these components out of render just fixed.
                key={JSON.stringify(r.scope)}
                busy={saving === `role:${r.role}`}
                current={r.scope}
                flat={flat}
                instruments={instruments}
                locationNameOf={nameOfLocation}
                onSave={(s) => save('role', r.role, s)}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-800">Per user — overrides their role</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          An override replaces the role’s scope, so it can grant more as well as less.
        </p>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {(data?.users ?? []).filter((u) => u.role !== 'SUPER_ADMIN').map((u) => {
            const roleScope = data?.roles.find((r) => r.role === u.role)?.scope ?? null;
            return (
              <div key={u.userId} className="p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-slate-800">{u.username}</span>
                  {u.fullName && <span className="text-xs text-slate-500">{u.fullName}</span>}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{u.role}</span>
                  <span className="text-xs text-slate-500">
                    currently: {describe(u.scope, u.scope === null ? u.role : undefined)}
                    {' · '}role default: {describe(roleScope)}
                  </span>
                </div>
                <ScopeEditor
                  key={JSON.stringify(u.scope)}
                  busy={saving === `user:${u.userId}`}
                  current={u.scope}
                  inheritFrom={u.role}
                  flat={flat}
                  instruments={instruments}
                  locationNameOf={nameOfLocation}
                  onSave={(s) => save('user', u.userId, s)}
                />
              </div>
            );
          })}
          {(data?.users ?? []).filter((u) => u.role !== 'SUPER_ADMIN').length === 0 && (
            <p className="p-4 text-sm text-slate-500">
              No non-Super-Admin users yet. Overrides apply to individual users within a role.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
