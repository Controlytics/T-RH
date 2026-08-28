import { useState } from 'react';
import useSWR from 'swr';
import { ATTRIBUTE_ACCESS_MODES, type AttributeAccessMode } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';

interface RoleAccess {
  role: string;
  mode: AttributeAccessMode | null;
  keys: string[];
  requireReauth: boolean;
  canUpdateInstruments: boolean;
}

/**
 * Which instrument attributes a role may change.
 *
 * ONE control for what used to be an ad-hoc Edit and Delete on every row. The
 * four states have to stay distinguishable, because collapsing any two of them
 * turns a restriction into a grant or the reverse:
 *
 *   not configured — inherits Edit Instruments, i.e. exactly the old behaviour
 *   ALL_EDIT       — every attribute
 *   ALL_VIEW       — read-only, including no Add
 *   SELECTED       — the ticked keys, everything else read-only
 *
 * Saved one role at a time and audited per save, like Instrument Scope beside
 * it — deliberately NOT part of the Permissions tab's bulk save. This rule names
 * attribute KEYS, and in a wholesale save an accidental clear would be
 * indistinguishable from a deliberate one.
 *
 * A role without Edit Instruments is read-only whatever is stored here: the rule
 * NARROWS that permission and never widens it. The tab says so rather than
 * offering a setting that would do nothing.
 */
export function AttributeAccessTab() {
  const { toast } = useToast();
  const { data, mutate } = useSWR<{ roles: RoleAccess[]; availableKeys: string[] }>(
    '/api/roles/attribute-access',
  );
  const [saving, setSaving] = useState<string | null>(null);
  /** Un-saved edits, keyed by role. Absent = showing what is stored. */
  const [draft, setDraft] = useState<Record<string, Partial<RoleAccess>>>({});

  const roles = data?.roles ?? [];
  const availableKeys = data?.availableKeys ?? [];

  const current = (r: RoleAccess): RoleAccess => ({ ...r, ...(draft[r.role] ?? {}) });
  const dirty = (r: RoleAccess) => Boolean(draft[r.role]);

  const edit = (role: string, patch: Partial<RoleAccess>) =>
    setDraft((d) => ({ ...d, [role]: { ...(d[role] ?? {}), ...patch } }));

  const save = async (r: RoleAccess) => {
    const next = current(r);
    setSaving(r.role);
    try {
      await apiClient.put(`/api/roles/attribute-access/${encodeURIComponent(r.role)}`, {
        mode: next.mode,
        // Sent even in ALL_EDIT / ALL_VIEW so a role switched back to SELECTED
        // does not silently reappear with the keys it had a month ago.
        keys: next.mode === 'SELECTED' ? next.keys : [],
        requireReauth: next.requireReauth,
      });
      setDraft((d) => { const { [r.role]: _drop, ...rest } = d; return rest; });
      await mutate();
      toast.success('Attribute access saved', `"${r.role}" updated.`);
    } catch (e) {
      toast.error('Could not save', (e as Error)?.message ?? 'The change was not saved.');
    } finally {
      setSaving(null);
    }
  };

  const toggleKey = (r: RoleAccess, key: string) => {
    const now = current(r);
    const has = now.keys.some((k) => k.trim().toLowerCase() === key.trim().toLowerCase());
    edit(r.role, {
      keys: has
        ? now.keys.filter((k) => k.trim().toLowerCase() !== key.trim().toLowerCase())
        : [...now.keys, key],
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        Which instrument attributes each role may change. A role left unconfigured
        keeps whatever Edit Instruments already gives it.
      </p>

      {roles.map((r) => {
        const now = current(r);
        const isSelected = now.mode === 'SELECTED';
        return (
          <div key={r.role} className="rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-800">{r.role}</h3>
                {!r.canUpdateInstruments && (
                  // Said plainly. Without this the admin sets ALL_EDIT, sees it
                  // save, and then finds the role still cannot edit anything.
                  <p className="mt-0.5 text-xs text-amber-700">
                    This role has no Edit Instruments permission, so its attributes
                    are read-only whatever is set here.
                  </p>
                )}
              </div>
              <Button
                type="button" size="sm"
                disabled={!dirty(r) || saving === r.role}
                onClick={() => void save(r)}
              >
                {saving === r.role ? 'Saving…' : 'Save'}
              </Button>
            </div>

            <div className="mt-3 flex flex-wrap gap-4">
              {([null, ...ATTRIBUTE_ACCESS_MODES] as (AttributeAccessMode | null)[]).map((m) => (
                <label key={String(m)} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="radio"
                    name={`mode-${r.role}`}
                    checked={now.mode === m}
                    onChange={() => edit(r.role, { mode: m })}
                  className="ctl-radio" />
                  {m === null ? 'Not configured' : MODE_LABEL[m]}
                </label>
              ))}
            </div>

            {isSelected && (
              <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
                  Editable attributes ({now.keys.length})
                </p>
                {availableKeys.length === 0 ? (
                  <p className="text-xs text-slate-500">
                    No attribute keys exist yet — add some on an instrument or in a
                    profile, and they will appear here.
                  </p>
                ) : (
                  <div className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
                    {availableKeys.map((k) => (
                      <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
                        <input
                          type="checkbox"
                          checked={now.keys.some((s) => s.trim().toLowerCase() === k.trim().toLowerCase())}
                          onChange={() => toggleKey(r, k)}
                        className="ctl-check" />
                        <span className="truncate" title={k}>{k}</span>
                      </label>
                    ))}
                  </div>
                )}
                {now.keys.length === 0 && (
                  // A real instruction someone may not have meant, said out loud
                  // rather than left to be discovered on an instrument page.
                  <p className="mt-2 text-xs text-amber-700">
                    Nothing ticked: this role can add new attributes but change none
                    of the existing ones.
                  </p>
                )}
              </div>
            )}

            <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                checked={now.requireReauth}
                disabled={now.mode === 'ALL_VIEW'}
                onChange={(e) => edit(r.role, { requireReauth: e.target.checked })}
              className="ctl-check" />
              Ask for the operator&apos;s password on every attribute change
            </label>
          </div>
        );
      })}

      {roles.length === 0 && (
        <p className="text-sm text-slate-500">No active roles.</p>
      )}
    </div>
  );
}

const MODE_LABEL: Record<AttributeAccessMode, string> = {
  ALL_EDIT: 'All editable',
  ALL_VIEW: 'All view-only',
  SELECTED: 'Selected editable, rest view-only',
};
