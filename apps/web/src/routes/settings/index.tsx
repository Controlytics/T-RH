import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  ALL_RECORDS_PARAM, isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN,
  canEditAttributeKey, type AttributeAccess,
} from '@digilog/shared';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { useAttributeLabels } from '@/hooks/use-attribute-labels';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { themeGradient } from '@/lib/theme-styles';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { type StatusTone } from '@/components/ui/status-badge';
import { Input } from '@/components/ui/input';
import { ReauthDialog } from '@/components/reauth-dialog';
import { RemarkDialog } from '@/routes/instruments/remark-dialog';

/**
 * Settings (2026-09-08). Operator, first pass: *"in side bar add settings, in
 * that page show the instrument details and attributes, there selected user
 * role should edit details, view details"*; second pass, on seeing a table:
 * *"in a square widget i need Instrument ID and value, Area and Value,
 * Building, and all the attribute keys and attributes values, these common
 * settings on top user will select instrument then that instrument values
 * should display in widget, what ever instruments assigned to that user, only
 * that instruments should come in selection"*.
 *
 * So: a COMMON SETTINGS bar with one instrument picker, and under it ONE
 * full-width widget of key / value rows for the chosen instrument (it was
 * square for an hour; operator: "remove the square shape, make widget full
 * width") — Instrument ID, then every attribute. "Assigned to that user" is
 * the instrument scope, which the SERVER applies to the list endpoint this
 * page reads; the picker offers exactly what came back and nothing is
 * re-derived here.
 *
 * BUILDING AND AREA ARE ATTRIBUTES, NOT SYNTHESISED ROWS. Every instrument on
 * this installation carries `Building` and `Area` as attribute keys (100 of
 * 100, measured 2026-09-08), so "Instrument ID and value, Area and Value,
 * Building, and all the attribute keys" is ONE list. A first cut also printed
 * the functional location's Block / Area as two extra rows, and the operator's
 * next message was "why area and building coming 2 times". Do not add them
 * back; the attribute rows are the ones the operator means.
 *
 * EDITING (operator, asked how): "One Edit button that opens the existing
 * Attributes panel". The widget is read-only; with `settings.edit` an Edit
 * button opens the panel in a dialog for THIS instrument, and the panel carries
 * the whole §11 flow wherever it is mounted — the role's Attribute Access rule,
 * mandatory remarks on a change, re-auth when the role requires it. Both read
 * the same SWR key, so a save in the dialog is on the widget when it closes.
 * Instrument ID is identity and is not editable here; Building and Area are
 * attributes like any other and edit through the panel.
 *
 * WHO: `settings.view` (INSTRUMENT_READ) shows the page; `settings.edit`
 * (INSTRUMENT_UPDATE) shows the Edit button. Both are Roles & Access → Sidebar
 * toggles. Presentation here; the route and the attribute routes are the control.
 */

interface Row {
  id: string; code: string; name: string; isActive: boolean; profileId: string;
  expectedIntervalSec: number | null; lastSeenAt: string | null; functionalLocationId: string | null;
}
interface Attribute {
  key: string;
  /** The STORED value. */
  value: string;
  /** `value` at this instrument's own decimals when it is a numeric slot — the
   *  form to PRINT. Null otherwise. Never a thing to save back. */
  display?: string | null;
  /** The SERVER's classification of the key (administered alias lists), which
   *  is what the tile's hue follows. Never re-derived from the key's text. */
  slot?: 'temperature' | 'humidity' | null;
  updatedAt?: string;
}

/**
 * Tile hues follow the dashboard's own vocabulary (`.tv-h-temp` burnt orange,
 * `.tv-h-rh` green in app.css) so a temperature bound reads the same colour
 * here as on the readings table; everything the server does not classify
 * takes the site theme. Presentation only — `slot` is the server's call.
 */
const TILE: Record<'temperature' | 'humidity' | 'other', { bar: string; wash: string; ink: string }> = {
  temperature: { bar: '#c2410c', wash: '#fff7ed', ink: '#9a3412' },
  humidity: { bar: '#15803d', wash: '#f0fdf4', ink: '#166534' },
  other: { bar: 'var(--theme-primary, #2a78d6)', wash: '#f8fafc', ink: '#0f172a' },
};

/** An attribute with nothing stored prints "(empty)", the panel's word. */
const LAST_PICK_KEY = 'settings.instrumentId';

function statusOf(r: Row, activeWindow: number): { tone: StatusTone; label: string } {
  if (!r.isActive) return { tone: 'idle', label: 'Disabled' };
  return isInstrumentReporting(r.lastSeenAt, r.expectedIntervalSec, activeWindow)
    ? { tone: 'ok', label: 'Reporting' }
    : { tone: 'warn', label: 'Not reporting' };
}

function readLastPick(): string {
  try { return localStorage.getItem(LAST_PICK_KEY) ?? ''; } catch { return ''; }
}

export function SettingsPage() {
  const can = useCan();
  const canEdit = can('settings.edit');
  const { formatDateTime } = useDatetimeFormat();

  const { data, isLoading, error } = useSWR<{ data: Row[]; total: number }>(`/api/instruments?${ALL_RECORDS_PARAM}`);
  const { data: activityConfig } = useSWR<{ activeWindowMinutes?: number }>('/api/config/instrument-activity/current');
  const activeWindow = activityConfig?.activeWindowMinutes ?? INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;

  const instruments = useMemo(() => data?.data ?? [], [data]);
  const options = useMemo(() => instruments.map((r) => ({ value: r.id, label: r.code })), [instruments]);

  // The last pick survives a reload (per browser, a convenience); otherwise the
  // first instrument, so the widget is never blank while there is something to show.
  const [picked, setPicked] = useState<string>(readLastPick);
  const selected = instruments.find((r) => r.id === picked) ?? instruments[0] ?? null;
  useEffect(() => {
    if (selected && selected.id !== picked) setPicked(selected.id);
  }, [selected, picked]);
  const pick = (id: string) => {
    setPicked(id);
    try { localStorage.setItem(LAST_PICK_KEY, id); } catch { /* storage unavailable */ }
  };

  const { data: attrs, mutate: mutateAttrs } = useSWR<{ data: Attribute[] }>(selected ? `/api/instruments/${selected.id}/attributes` : null);
  const { mutate: mutateList } = useSWR<{ data: Row[]; total: number }>(`/api/instruments?${ALL_RECORDS_PARAM}`);
  const { labelFor } = useAttributeLabels();
  const { toast } = useToast();
  const reauth = useReauth();

  /**
   * INLINE editing (2026-09-16, operator: "when user clicks on edit values
   * should be editable but another edit popup was showing and also in settings
   * Instrument id should be changable"). Edit turns the tiles into inputs in
   * place; Save signs the changed attributes with ONE remark and writes each
   * changed KEY through the same endpoints the Attributes panel uses, so the
   * §11 flow is unchanged: the role's attribute rule decides which tiles are
   * inputs (`GET /attribute-access/me`, the panel's own source), a change needs
   * a reason, and re-authentication is the hook's business. The Instrument ID
   * goes to `PUT /api/instruments/:id` — it is the MQTT client id, and the
   * server moves the broker slots; the device must reconnect with the new id.
   */
  const { data: accessRes, error: accessError } = useSWR<{
    mode: string | null; keys: string[]; requireReauth: boolean;
  }>('/api/instruments/attribute-access/me', { revalidateOnFocus: false });
  const accessLoaded = Boolean(accessRes) || Boolean(accessError);
  const access: AttributeAccess | null = accessRes?.mode
    ? { mode: accessRes.mode as AttributeAccess['mode'], keys: accessRes.keys ?? [], requireReauth: accessRes.requireReauth === true }
    : null;
  const permitted = canEdit && accessLoaded && !accessError;
  const mayEdit = (k: string) => canEditAttributeKey(access, k, permitted);

  const [editing, setEditing] = useState(false);
  /** Attribute drafts by KEY, and the Instrument ID draft. Seeded on Edit. */
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [draftCode, setDraftCode] = useState('');
  const [remarkOpen, setRemarkOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // Leaving the instrument leaves edit mode: a draft for one device must never
  // be saved against another.
  useEffect(() => { setEditing(false); setRemarkOpen(false); }, [selected?.id]);

  const startEdit = () => {
    if (!selected) return;
    setDraft(Object.fromEntries((attrs?.data ?? []).map((a) => [a.key, a.value])));
    setDraftCode(selected.code);
    setEditing(true);
  };
  const cancelEdit = () => { setEditing(false); setRemarkOpen(false); };

  /** Changed attributes the role may edit — what a Save writes. */
  const changes = (attrs?.data ?? [])
    .filter((a) => mayEdit(a.key) && draft[a.key] !== undefined && draft[a.key] !== a.value)
    .map((a) => ({ key: a.key, label: labelFor(a.key), from: a.value, to: draft[a.key] }));
  const newCode = draftCode.trim();
  const codeChanged = Boolean(selected) && newCode !== '' && newCode !== selected!.code;

  const onSave = () => {
    // No rule on the code (2026-09-16, operator) — see `codeSchema` in
    // `@digilog/shared` for what a wildcard costs on the wire.
    if (changes.length === 0 && !codeChanged) { setEditing(false); return; }
    if (changes.length > 0) { setRemarkOpen(true); return; }
    void commit(null);
  };

  /**
   * One `reauth.execute` for the whole batch. The first attempt goes out with
   * no password; if the role's rule demands one the backend answers 401 and the
   * hook replays this callback — so it is IDEMPOTENT: every request already
   * made is skipped on the replay, or a replay would write the same change
   * twice and the trail would say so.
   */
  const commit = (remark: string | null) => {
    if (!selected) return;
    const done = new Set<string>();
    let codeDone = false;
    setBusy(true);
    reauth.execute(
      'UPDATE_INSTRUMENT_ATTRIBUTE',
      async (password) => {
        for (const c of changes) {
          if (done.has(c.key)) continue;
          const url = `/api/instruments/${selected.id}/attributes/${encodeURIComponent(c.key)}`;
          const body = { value: c.to, reason: remark ?? '' };
          if (password) await apiClient.putWithReauth(url, body, password);
          else await apiClient.put(url, body);
          done.add(c.key);
        }
        if (codeChanged && !codeDone) {
          await apiClient.put(`/api/instruments/${selected.id}`, { code: newCode });
          codeDone = true;
        }
      },
      {
        onSuccess: async () => {
          setBusy(false);
          setRemarkOpen(false);
          setEditing(false);
          await mutateAttrs();
          if (codeChanged) await mutateList();
          toast.success('Saved', codeChanged
            ? `Instrument ID is now ${newCode}. Reconnect the device with the new ID.`
            : `${changes.length} attribute${changes.length === 1 ? '' : 's'} updated.`);
        },
        onCancel: () => setBusy(false),
        onError: (err) => {
          setBusy(false);
          toast.error('Could not save', (err as { message?: string })?.message ?? 'The changes were not saved.');
        },
      },
    );
  };

  // Two tiles per line on a wide viewport, one below the other on a narrow one
  // (operator: "increase font sizes and in single line two attributes and
  // their values should come"). A tile is one grid cell: the key in sentence
  // case, the value large in tabular numerals, and when it was last written.
  const tile = (
    label: string,
    value: string | null | undefined,
    opts: { muted?: boolean; slot?: Attribute['slot']; updatedAt?: string; edit?: { value: string; onChange: (v: string) => void; problem?: string | null } } = {},
  ) => {
    const hue = TILE[opts.slot ?? 'other'];
    return (
      <div
        data-row
        className="relative flex min-w-0 flex-col gap-1 overflow-hidden rounded-[var(--radius-card)] border border-slate-200/80 py-3 pl-5 pr-4"
        style={{ background: hue.wash, boxShadow: `inset 4px 0 0 0 ${hue.bar}` }}
      >
        <dt className="text-[0.8125rem] font-medium text-slate-500">{label}</dt>
        {opts.edit ? (
          <dd className="min-w-0">
            {/* The STORED value is edited, never the display form. */}
            <Input
              value={opts.edit.value}
              autoComplete="off"
              aria-label={label}
              onChange={(e) => opts.edit!.onChange(e.target.value)}
              className={`font-display text-lg font-semibold ${opts.edit.problem ? 'border-red-400' : ''}`}
            />
            {opts.edit.problem && <span className="mt-1 block text-xs text-red-600">{opts.edit.problem}</span>}
          </dd>
        ) : (
          <dd
            className={`font-display min-w-0 break-words text-xl leading-tight tabular-nums ${opts.muted ? 'font-normal text-slate-400' : 'font-semibold'}`}
            style={opts.muted ? undefined : { color: hue.ink }}
          >
            {value}
          </dd>
        )}
        {opts.updatedAt && (
          <span className="text-[0.6875rem] text-slate-400">Updated {formatDateTime(opts.updatedAt)}</span>
        )}
      </div>
    );
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Pick an instrument; the widget shows its Instrument ID and every attribute."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Settings' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        }
      />

      {/* Common settings: the one control every widget on this page reads. */}
      <section
        aria-label="Common settings"
        className="flex flex-wrap items-center gap-4 rounded-[var(--radius-card)] border border-slate-200 bg-white px-5 py-4 shadow-[var(--elev-1)]"
      >
        <span className="text-xs font-bold uppercase tracking-[0.08em] text-slate-600">Instrument</span>
        <SearchableSelect
          value={selected?.id ?? ''}
          onChange={pick}
          options={options}
          placeholder={isLoading ? 'Loading…' : 'Select an instrument'}
          searchPlaceholder="Search instrument ID"
          disabled={isLoading || options.length === 0}
          className="w-72"
        />
        {!isLoading && !error && options.length === 0 && (
          <span className="text-sm text-slate-500">No instruments are assigned to you.</span>
        )}
        {error && <span className="text-sm text-red-700">The instruments could not be loaded. Try again.</span>}
      </section>

      {selected && (
        <div
          data-testid="settings-widget"
          className="flex w-full flex-col overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-2)]"
        >
          {/* The one bold element: the site-theme band, the code large, the
              instrument's state and last report beside it. */}
          <div className="relative px-6 py-5 text-white" style={themeGradient}>
            <div
              aria-hidden
              className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-white/10"
            />
            <div className="relative flex flex-wrap items-end justify-between gap-4">
              <div className="min-w-0">
                <div className="text-[0.8125rem] font-medium text-white/75">Instrument</div>
                <div className="font-display truncate text-3xl font-bold leading-none tracking-tight">{selected.code}</div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-right text-[0.8125rem] text-white/80">
                  <div className="font-semibold text-white">{statusOf(selected, activeWindow).label}</div>
                  <div>{selected.lastSeenAt ? `Last report ${formatDateTime(selected.lastSeenAt)}` : 'No report yet'}</div>
                </div>
                <span
                  aria-hidden
                  className={`h-3 w-3 rounded-full ring-4 ring-white/25 ${statusOf(selected, activeWindow).tone === 'ok' ? 'bg-emerald-300' : statusOf(selected, activeWindow).tone === 'warn' ? 'bg-amber-300' : 'bg-slate-300'}`}
                />
                {canEdit && !editing && (
                  <Button
                    size="sm"
                    variant="secondary"
                    className="border-white/40 bg-white/15 text-white hover:bg-white/25"
                    onClick={startEdit}
                  >
                    Edit
                  </Button>
                )}
                {editing && (
                  <>
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      className="border-white/40 bg-white/15 text-white hover:bg-white/25"
                      onClick={cancelEdit}
                    >
                      Cancel
                    </Button>
                    <Button size="sm" disabled={busy} className="bg-white text-slate-900 hover:bg-white/90" onClick={onSave}>
                      {busy ? 'Saving…' : 'Save'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>
          <dl className="grid grid-cols-1 gap-3 p-5 md:grid-cols-2">
            {tile('Instrument ID', selected.code, editing
              ? { edit: { value: draftCode, onChange: (v) => setDraftCode(v) } }
              : {})}
            {(attrs?.data ?? []).map((a) => (
              <div key={a.key} className="contents">
                {tile(labelFor(a.key), a.display ?? (a.value || '(empty)'), {
                  muted: !a.display && !a.value, slot: a.slot, updatedAt: a.updatedAt,
                  // Only a key the role may edit becomes an input; the rest
                  // stay tiles, exactly as the Attributes panel would refuse them.
                  ...(editing && mayEdit(a.key)
                    ? { edit: { value: draft[a.key] ?? a.value, onChange: (v: string) => setDraft((d) => ({ ...d, [a.key]: v })) } }
                    : {}),
                })}
              </div>
            ))}
          </dl>
        </div>
      )}

      <RemarkDialog
        open={remarkOpen}
        attributeKey=""
        from=""
        changes={changes.map((c) => ({ label: c.label, from: c.from, to: c.to }))}
        busy={busy}
        onSubmit={(remark) => void commit(remark)}
        onClose={() => { if (!busy) setRemarkOpen(false); }}
      />
      <ReauthDialog
        open={reauth.isOpen}
        actionLabel="Update Instrument Attribute"
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
      />
    </div>
  );
}
