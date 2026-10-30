import { useRef, useState } from 'react';
import useSWR from 'swr';
import {
  DASHBOARD_SOURCE_INSTRUMENTS_MAX, dashboardSourceSchema, dashboardTimeWindowSchema,
  type DashboardDetail, type DashboardSource, type DashboardTimeWindow,
} from '@digilog/shared';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { FormSection } from '@/components/ui/form-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { useHistoryScope } from '@/routes/data-report/use-history-scope';
import { areasOf } from '@/routes/instruments/history-selection';
import { saveDashboard } from './use-dashboards';
import { TimeWindowPicker } from './time-window-picker';
import { DESCRIPTION_MAX, TITLE_MAX } from './name-dialog';

/**
 * Dashboard Settings (SUPER_ADMIN; design section 4): the title and description,
 * which instruments the dashboard covers, and the default time window.
 *
 * Save is ONE `PUT /api/dashboards/:id` carrying the WHOLE stored document with
 * `source` and `timeWindow` replaced, and the `updatedAt` the dialog was opened
 * on (both captured at open, ruling R10). Everything is checked by the SAME shared schemas the server applies, and
 * their own words are shown in place. The page offers Settings outside edit
 * mode only, so the stored document IS the current one; a draft is never
 * merged here.
 *
 * An UNREADABLE stored source (`null`) starts with NO mode chosen and Save
 * asks for one. It is never shown as "All instruments": that would turn a
 * corrupt scope into the widest one with a single click on Save.
 */

type Mode = DashboardSource['mode'];

const MODES: { mode: Mode; label: string }[] = [
  { mode: 'all', label: 'All instruments' },
  { mode: 'profile', label: 'A profile' },
  { mode: 'location', label: 'A location' },
  { mode: 'instruments', label: 'Pick instruments' },
];

interface LocationNode { id: string; name: string; children?: LocationNode[] }

export function SettingsDialog({ open, dashboard, onClose, onSaved, onReload }: {
  open: boolean;
  dashboard: DashboardDetail;
  onClose: () => void;
  /** Called with the WHOLE server response, so the page adopts it as it is. */
  onSaved: (saved: DashboardDetail) => void;
  /** Re-reads the dashboard after a 409. */
  onReload?: () => Promise<unknown>;
}) {
  // Mounted only while open, so every open starts from the stored dashboard.
  return open ? <SettingsBody dashboard={dashboard} onClose={onClose} onSaved={onSaved} onReload={onReload} /> : null;
}

function SettingsBody({ dashboard, onClose, onSaved, onReload }: {
  dashboard: DashboardDetail;
  onClose: () => void;
  onSaved: (saved: DashboardDetail) => void;
  onReload?: () => Promise<unknown>;
}) {
  // Captured ONCE, when the dialog opens (this body mounts per open): the
  // `updatedAt` and document the form is seeded from. Save sends THESE, never the
  // live prop, which a focus revalidation can replace with another editor's save
  // while the form still holds this editor's fields (ruling R10).
  const [base] = useState(() => ({ updatedAt: dashboard.updatedAt, document: dashboard.document }));
  const stored = base.document.source;
  const [title, setTitle] = useState(dashboard.title);
  const [description, setDescription] = useState(dashboard.description ?? '');
  const [mode, setMode] = useState<Mode | null>(stored?.mode ?? null);
  const [profileId, setProfileId] = useState(stored?.mode === 'profile' ? stored.profileId : '');
  const [locationId, setLocationId] = useState(stored?.mode === 'location' ? stored.functionalLocationId : '');
  const [directOnly, setDirectOnly] = useState(stored?.mode === 'location' ? stored.directOnly : false);
  const [picked, setPicked] = useState<string[]>(stored?.mode === 'instruments' ? stored.ids : []);
  const [timeWindow, setTimeWindow] = useState<DashboardTimeWindow>(base.document.timeWindow);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);

  const reauth = useReauth();
  const { toast } = useToast();
  const scope = useHistoryScope();
  const { data: profileData } = useSWR<{ data: { id: string; name: string }[] }>('/api/instrument-profiles');
  const profiles = profileData?.data ?? [];

  // The location is ONE id (the Area when chosen, else the Block); the two
  // selects are derived from it, so there is no second state to drift.
  const tree = scope.tree as LocationNode[];
  const blockId = tree.find((b) => b.id === locationId || b.children?.some((c) => c.id === locationId))?.id ?? '';
  const areaId = blockId && locationId !== blockId ? locationId : '';

  const togglePicked = (id: string) => setPicked((p) => (p.includes(id)
    ? p.filter((x) => x !== id)
    : p.length >= DASHBOARD_SOURCE_INSTRUMENTS_MAX ? p : [...p, id]));

  const save = () => {
    setProblem(null);
    const trimmed = title.trim();
    if (!trimmed) { setProblem('Give the dashboard a title.'); return; }
    if (mode === null) { setProblem('Choose which instruments this dashboard covers.'); return; }
    const rawSource = mode === 'all' ? { mode }
      : mode === 'profile' ? { mode, profileId }
        : mode === 'location' ? { mode, functionalLocationId: locationId, directOnly }
          : { mode, ids: picked };
    const src = dashboardSourceSchema.safeParse(rawSource);
    if (!src.success) { setProblem(src.error.issues[0]?.message ?? 'These instruments are not valid.'); return; }
    const win = dashboardTimeWindowSchema.safeParse(timeWindow);
    if (!win.success) { setProblem(win.error.issues[0]?.message ?? 'This is not a time window.'); return; }

    const body = {
      title: trimmed,
      description: description.trim() || null,
      document: { ...base.document, source: src.data, timeWindow: win.data },
      expectedUpdatedAt: base.updatedAt,
    };
    let saved: DashboardDetail | undefined;
    setBusy(true);
    void reauth.execute('UPDATE_DASHBOARD', async (password?: string) => {
      saved = await saveDashboard(dashboard.id, body, password);
    }, {
      onSuccess: () => {
        setBusy(false);
        toast.success('Settings saved', `"${trimmed}" saved.`);
        if (saved) onSaved(saved);
        onClose();
      },
      onError: (e: unknown) => {
        setBusy(false);
        if ((e as { code?: string })?.code === 'DASHBOARD_CHANGED') { setConflict(true); return; }
        setProblem((e as { message?: string })?.message || 'Could not save. Please try again.');
      },
      onCancel: () => setBusy(false),
    });
  };

  const reload = async () => {
    setReloading(true);
    try {
      await onReload?.();
      setConflict(false);
      onClose();
    } finally {
      setReloading(false);
    }
  };

  return (
    <>
      <Dialog open onClose={onClose} className="max-w-2xl">
      <DialogBanner title="Dashboard settings" subtitle={dashboard.title} />
      <form
        className="space-y-4"
        onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}
      >
        <FormSection title="Details" columns={1}>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Title</span>
            <Input name="dashboard-title" value={title} maxLength={TITLE_MAX} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium text-slate-700">Description</span>
            <Input name="dashboard-description" value={description} maxLength={DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} />
          </label>
        </FormSection>

        <FormSection title="Instruments" columns={1}>
          <div role="radiogroup" aria-label="Instruments covered" className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {MODES.map((m) => (
              <label key={m.mode} className="flex items-center gap-2">
                <input
                  type="radio"
                  className="ctl-radio"
                  name="dashboard-source-mode"
                  checked={mode === m.mode}
                  onChange={() => { setMode(m.mode); setProblem(null); }}
                />
                {m.label}
              </label>
            ))}
          </div>

          {mode === 'profile' && (
            <Select aria-label="Profile" name="dashboard-source-profile" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
              <option value="">Choose a profile</option>
              {profiles.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          )}

          {mode === 'location' && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-2">
                <Select aria-label="Block" name="dashboard-source-block" value={blockId} onChange={(e) => setLocationId(e.target.value)}>
                  <option value="">Choose a block</option>
                  {tree.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </Select>
                <Select
                  aria-label="Area"
                  name="dashboard-source-area"
                  value={areaId}
                  disabled={!blockId}
                  onChange={(e) => setLocationId(e.target.value || blockId)}
                >
                  <option value="">All areas</option>
                  {areasOf(tree, blockId).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </Select>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="ctl-check"
                  name="dashboard-source-direct-only"
                  checked={directOnly}
                  onChange={(e) => setDirectOnly(e.target.checked)}
                />
                Direct only
              </label>
            </div>
          )}

          {mode === 'instruments' && (
            <div className="space-y-2 rounded-md border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <select aria-label="List block" className="ctl ctl-sm" value={scope.blockId} onChange={(e) => scope.setBlock(e.target.value)}>
                  <option value="">All blocks</option>
                  {scope.tree.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
                <select aria-label="List area" className="ctl ctl-sm" value={scope.areaId} disabled={!scope.blockId} onChange={(e) => scope.setArea(e.target.value)}>
                  <option value="">All areas</option>
                  {scope.areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
                <span className="text-xs text-slate-500">
                  {picked.length} picked (at most {DASHBOARD_SOURCE_INSTRUMENTS_MAX})
                </span>
              </div>
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
                {scope.inScope.map((i) => (
                  <label key={i.id} className="flex items-center gap-1.5 rounded-md border border-slate-200 px-2 py-1 text-xs">
                    <input
                      type="checkbox"
                      className="ctl-check"
                      checked={picked.includes(i.id)}
                      onChange={() => togglePicked(i.id)}
                      aria-label={i.code}
                    />
                    {i.code}
                  </label>
                ))}
              </div>
            </div>
          )}
        </FormSection>

        <FormSection title="Default time window" columns={1}>
          <TimeWindowPicker tone="light" value={timeWindow} onChange={setTimeWindow} />
        </FormSection>

        {problem && <p role="alert" className="text-sm font-medium text-red-700">{problem}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={!title.trim() || busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </form>
      </Dialog>

      <Dialog open={conflict} onClose={() => setConflict(false)} priority>
        <DialogBanner tone="danger" title="This dashboard was changed by someone else." />
        <p className="text-sm text-slate-600">
          Your settings cannot be saved over theirs. Reload shows the saved dashboard and discards your changes.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={reloading} onClick={() => setConflict(false)}>Keep editing</Button>
          <Button type="button" disabled={reloading} onClick={() => { void reload(); }}>
            {reloading ? 'Reloading…' : 'Reload'}
          </Button>
        </DialogFooter>
      </Dialog>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update dashboard"
      />
    </>
  );
}
