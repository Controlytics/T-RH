import { useState } from 'react';
import useSWR from 'swr';
import { PANELS, PANEL_PAGES } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';

interface RolePanels { role: string; panels: string[] | null }
interface UserPanels { userId: string; username: string; fullName: string | null; role: string; panels: string[] | null }

const ALL_KEYS = PANELS.map((p) => p.key);

const toggle = (list: string[], key: string, on: boolean) =>
  on ? [...list, key] : list.filter((k) => k !== key);

/**
 * The panel checklist, grouped by page.
 *
 * Declared at module scope, NOT inside the tab component: a component defined
 * during render is a new type on every render, so React unmounts and remounts it —
 * which silently discards a half-finished selection whenever SWR revalidates (on
 * window focus, for instance) or another row saves.
 */
function PanelPicker({ value, onChange }: { value: string[]; onChange: (next: string[]) => void }) {
  return (
    <div className="mt-2 grid gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3 md:grid-cols-2">
      {PANEL_PAGES.map(({ page, label }) => (
        <div key={page}>
          <p className="pb-1 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <div className="space-y-1.5">
            {PANELS.filter((p) => p.page === page).map((p) => (
              <label key={p.key} className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={value.includes(p.key)}
                  onChange={(e) => onChange(toggle(value, p.key, e.target.checked))}
                />
                <span>
                  <span className="font-medium">{p.label}</span>
                  <span className="block text-xs text-slate-500">{p.description}</span>
                </span>
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function PanelEditor({
  busy, current, inheritFrom, onSave,
}: {
  busy: boolean;
  current: string[] | null;
  inheritFrom?: string | null;
  onSave: (next: string[] | null) => void;
}) {
  const [limited, setLimited] = useState(current !== null);
  // Seeded with EVERY key when nothing is stored: switching to "only selected" and
  // finding nothing ticked would read as "this role sees nothing", which is the
  // opposite of what it currently does.
  const [picked, setPicked] = useState<string[]>(current ?? ALL_KEYS);
  const unlimitedLabel = inheritFrom !== undefined ? 'Inherit role' : 'All panels';

  return (
    <div className="mt-2">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={!limited} onChange={() => setLimited(false)} />
          <span>{unlimitedLabel}</span>
        </label>
        <label className="flex items-center gap-1.5">
          <input type="radio" checked={limited} onChange={() => setLimited(true)} />
          <span>Only selected panels</span>
        </label>
        <Button className="ml-auto" disabled={busy} onClick={() => onSave(limited ? picked : null)}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {limited && <PanelPicker value={picked} onChange={setPicked} />}
      {limited && picked.length === 0 && (
        <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Nothing selected — this shows <strong>no panels at all</strong>. Choose
          “{unlimitedLabel}” instead if that is not what you mean.
        </p>
      )}
    </div>
  );
}

/**
 * Panel assignment, per role and per user.
 *
 * THREE STATES, and the UI must keep them distinguishable because collapsing them
 * turns a deny into a grant:
 *   null    — inherit (user → role → every panel)
 *   []      — NO panels
 *   [keys]  — these panels
 *
 * Identical in shape to the Instrument Scope tab beside it, deliberately: the two
 * are the only reasons a user sees less than everything, and one mental model for
 * both is worth more than any per-tab cleverness.
 */
export function PanelAccessTab() {
  const { toast } = useToast();
  const { data, mutate } = useSWR<{ roles: RolePanels[]; users: UserPanels[] }>('/api/roles/panel-access');
  const [saving, setSaving] = useState<string | null>(null);

  const describe = (panels: string[] | null, inheritFrom?: string | null) => {
    if (panels === null) {
      return inheritFrom !== undefined
        ? `Inherits role${inheritFrom ? ` (${inheritFrom})` : ''}`
        : 'All panels';
    }
    if (panels.length === 0) return 'No panels';
    return panels.map((k) => PANELS.find((p) => p.key === k)?.label ?? k).join(', ');
  };

  const save = async (kind: 'role' | 'user', key: string, panels: string[] | null) => {
    setSaving(`${kind}:${key}`);
    try {
      await apiClient.put(`/api/roles/panel-access/${kind}/${encodeURIComponent(key)}`, { panels });
      toast.success('Panels updated', panels === null
        ? (kind === 'role' ? 'Sees all panels.' : 'Now inherits the role.')
        : panels.length === 0 ? 'Sees no panels.' : `Limited to ${panels.length} panel(s).`);
      await mutate();
    } catch (e) {
      toast.error('Could not save', (e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="space-y-6">
      {/*
        Stated on the screen, not just in the design doc. An admin who hides the
        alarms widget believing they have withheld alarm data has been misled by
        this UI, and that is the failure this feature can most easily cause.
      */}
      <p className="rounded-lg border border-sky-200 bg-sky-50 px-3 py-2 text-xs text-sky-800">
        Hiding a panel changes what is <strong>shown</strong>, not what a user may reach — it does
        not withhold data from the API. Use <strong>Instrument Scope</strong> to restrict which
        instruments and readings a user can access.
      </p>

      <div>
        <h3 className="text-sm font-semibold text-slate-800">Per role</h3>
        <p className="mt-0.5 text-xs text-slate-500">Super Admin always sees every panel and is not listed.</p>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {(data?.roles ?? []).filter((r) => r.role !== 'SUPER_ADMIN').map((r) => (
            <div key={r.role} className="p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-semibold text-slate-800">{r.role}</span>
                <span className="text-xs text-slate-500">currently: {describe(r.panels)}</span>
              </div>
              <PanelEditor
                // Re-seeds the editor from the server value, and ONLY when that
                // value actually changes. A broader key would discard a
                // half-finished selection on any revalidation.
                key={JSON.stringify(r.panels)}
                busy={saving === `role:${r.role}`}
                current={r.panels}
                onSave={(p) => save('role', r.role, p)}
              />
            </div>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-sm font-semibold text-slate-800">Per user — overrides their role</h3>
        <p className="mt-0.5 text-xs text-slate-500">
          An override replaces the role’s list, so it can grant more as well as less.
        </p>
        <div className="mt-3 divide-y divide-slate-100 rounded-xl border border-slate-200 bg-white">
          {(data?.users ?? []).filter((u) => u.role !== 'SUPER_ADMIN').map((u) => {
            const rolePanels = data?.roles.find((r) => r.role === u.role)?.panels ?? null;
            return (
              <div key={u.userId} className="p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="font-semibold text-slate-800">{u.username}</span>
                  {u.fullName && <span className="text-xs text-slate-500">{u.fullName}</span>}
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] font-semibold text-slate-600">{u.role}</span>
                  <span className="text-xs text-slate-500">
                    currently: {describe(u.panels, u.panels === null ? u.role : undefined)}
                    {' · '}role default: {describe(rolePanels)}
                  </span>
                </div>
                <PanelEditor
                  key={JSON.stringify(u.panels)}
                  busy={saving === `user:${u.userId}`}
                  current={u.panels}
                  inheritFrom={u.role}
                  onSave={(p) => save('user', u.userId, p)}
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
