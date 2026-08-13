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

interface RoleScope { role: string; scope: string[] | null }
interface UserScope { userId: string; username: string; fullName: string | null; role: string; scope: string[] | null }

/**
 * Instrument visibility scope, per role and per user.
 *
 * THREE STATES, and the UI must keep them distinguishable because collapsing them
 * turns a deny into a grant:
 *   null  — inherit (user → role → all instruments)
 *   []    — SEE NOTHING
 *   [ids] — these functional locations
 *
 * "All instruments" writes null. "Only selected locations" with nothing ticked
 * writes [] and the UI says so out loud, because that is a real instruction someone
 * may not have meant.
 *
 * A user override REPLACES the role's scope and can therefore WIDEN it. The role's
 * current setting is named beside every override so nobody widens by accident.
 */
export function InstrumentScopeTab() {
  const { toast } = useToast();
  const { data: tree } = useSWR<{ data: FlNode[] }>('/api/functional-locations');
  const { data, mutate } = useSWR<{ roles: RoleScope[]; users: UserScope[] }>('/api/roles/instrument-scope');
  const [saving, setSaving] = useState<string | null>(null);

  const locations = tree?.data ?? [];
  const flat = useMemo(
    () => locations.flatMap((b) => [{ node: b, depth: 0 }, ...b.children.map((c) => ({ node: c, depth: 1 }))]),
    [locations],
  );
  const nameOf = (id: string) => flat.find((f) => f.node.id === id)?.node.name ?? '(deleted location)';

  const describe = (scope: string[] | null, inheritFrom?: string | null) => {
    if (scope === null) {
      return inheritFrom !== undefined
        ? `Inherits role${inheritFrom ? ` (${inheritFrom})` : ''}`
        : 'All instruments';
    }
    if (scope.length === 0) return 'Sees nothing';
    return scope.map(nameOf).join(', ');
  };

  const save = async (kind: 'role' | 'user', key: string, scope: string[] | null) => {
    setSaving(`${kind}:${key}`);
    try {
      await apiClient.put(`/api/roles/instrument-scope/${kind}/${encodeURIComponent(key)}`, { scope });
      toast.success('Visibility updated', scope === null
        ? (kind === 'role' ? 'Sees all instruments.' : 'Now inherits the role.')
        : scope.length === 0 ? 'Sees no instruments.' : `Limited to ${scope.length} location(s).`);
      await mutate();
    } catch (e) {
      toast.error('Could not save', (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  /** Checkbox list shared by the role and user editors. */
  const LocationPicker = ({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) => (
    <div className="mt-2 space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
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
            onChange={(e) => onChange(e.target.checked ? [...value, node.id] : value.filter((v) => v !== node.id))}
          />
          <span>{node.name}</span>
          <span className="text-xs text-slate-500">
            {node.type === 'BLOCK' ? `Block · ${node.totalCount} incl. areas` : `Area · ${node.ownCount}`}
          </span>
        </label>
      ))}
      {/* Stated, not implied: ticking a Block grants everything beneath it. */}
      {flat.some((f) => f.depth === 0) && (
        <p className="pt-1 text-[11px] text-slate-500">
          Selecting a Block also grants its Areas. Instruments in no location stay hidden from any limited scope.
        </p>
      )}
    </div>
  );

  const Editor = ({
    id, current, inheritFrom, onSave,
  }: { id: string; current: string[] | null; inheritFrom?: string | null; onSave: (s: string[] | null) => void }) => {
    const [limited, setLimited] = useState(current !== null);
    const [picked, setPicked] = useState<string[]>(current ?? []);
    const busy = saving === id;
    return (
      <div className="mt-2">
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={!limited} onChange={() => setLimited(false)} />
            <span>{inheritFrom !== undefined ? 'Inherit role' : 'All instruments'}</span>
          </label>
          <label className="flex items-center gap-1.5">
            <input type="radio" checked={limited} onChange={() => setLimited(true)} />
            <span>Only selected locations</span>
          </label>
          <Button
            className="ml-auto"
            disabled={busy}
            onClick={() => onSave(limited ? picked : null)}
          >
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
        {limited && <LocationPicker value={picked} onChange={setPicked} />}
        {limited && picked.length === 0 && (
          <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Nothing selected — this will show <strong>no instruments at all</strong>. Choose
            “{inheritFrom !== undefined ? 'Inherit role' : 'All instruments'}” instead if that is not what you mean.
          </p>
        )}
      </div>
    );
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
              <Editor
                id={`role:${r.role}`}
                current={r.scope}
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
                <Editor
                  id={`user:${u.userId}`}
                  current={u.scope}
                  inheritFrom={u.role}
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
