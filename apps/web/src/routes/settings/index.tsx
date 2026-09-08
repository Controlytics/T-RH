import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS_PARAM, isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { useCan } from '@/hooks/use-can';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AttributesPanel } from '@/routes/instruments/attributes-panel';

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
 * square widget of key / value rows for the chosen instrument — Instrument ID,
 * Building, Area, then every attribute. "Assigned to that user" is the
 * instrument scope, which the SERVER applies to the list endpoint this page
 * reads; the picker offers exactly what came back and nothing is re-derived
 * here. Building and Area are the functional location's Block and Area,
 * resolved by id off the same tree the Data Report page reads.
 *
 * EDITING (operator, asked how): "One Edit button that opens the existing
 * Attributes panel". The widget is read-only; with `settings.edit` an Edit
 * button opens the panel in a dialog for THIS instrument, and the panel carries
 * the whole §11 flow wherever it is mounted — the role's Attribute Access rule,
 * mandatory remarks on a change, re-auth when the role requires it. Both read
 * the same SWR key, so a save in the dialog is on the widget when it closes.
 * Instrument ID, Building and Area are identity and placement, not attributes,
 * and are not editable here.
 *
 * WHO: `settings.view` (INSTRUMENT_READ) shows the page; `settings.edit`
 * (INSTRUMENT_UPDATE) shows the Edit button. Both are Roles & Access → Sidebar
 * toggles. Presentation here; the route and the attribute routes are the control.
 */

interface Row {
  id: string; code: string; name: string; isActive: boolean; profileId: string;
  expectedIntervalSec: number | null; lastSeenAt: string | null; functionalLocationId: string | null;
}
interface LocationNode { id: string; name: string; children?: LocationNode[] }
interface Attribute {
  key: string;
  /** The STORED value. */
  value: string;
  /** `value` at this instrument's own decimals when it is a numeric slot — the
   *  form to PRINT. Null otherwise. Never a thing to save back. */
  display?: string | null;
}

/** Empty states are worded APART, as on the dashboard: no functional location
 *  is "Unassigned"; an attribute with nothing stored is "(empty)", the panel's word. */
const UNASSIGNED = 'Unassigned';
const LAST_PICK_KEY = 'settings.instrumentId';

/** Block and Area names for a functional-location id, off the Block > Area tree.
 *  An id that is a Block gives the Block alone; an Area gives both. */
export function placementOf(tree: LocationNode[], id: string | null): { building: string | null; area: string | null } {
  if (!id) return { building: null, area: null };
  for (const block of tree) {
    if (block.id === id) return { building: block.name, area: null };
    for (const area of block.children ?? []) {
      if (area.id === id) return { building: block.name, area: area.name };
    }
  }
  return { building: null, area: null };
}

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

  const { data, isLoading, error } = useSWR<{ data: Row[]; total: number }>(`/api/instruments?${ALL_RECORDS_PARAM}`);
  const { data: treeData } = useSWR<{ data: LocationNode[] }>('/api/functional-locations');
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

  const { data: attrs } = useSWR<{ data: Attribute[] }>(selected ? `/api/instruments/${selected.id}/attributes` : null);
  const placement = placementOf(treeData?.data ?? [], selected?.functionalLocationId ?? null);
  const [editing, setEditing] = useState(false);

  const row = (label: string, value: string | null | undefined, muted = false) => (
    <div data-row className="flex items-baseline justify-between gap-4 border-b border-slate-100 py-2 last:border-b-0">
      <dt className="shrink-0 text-xs font-semibold uppercase tracking-[0.06em] text-slate-500">{label}</dt>
      <dd className={`min-w-0 break-words text-right text-sm ${muted ? 'text-slate-400' : 'font-medium text-slate-800'}`}>{value}</dd>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Pick an instrument; the widget shows its identity, placement and every attribute."
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
          className="flex w-full max-w-md flex-col rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)] sm:aspect-square"
        >
          <div className="flex items-center justify-between gap-3 border-b border-slate-200 px-5 py-3">
            <div className="flex min-w-0 items-center gap-3">
              <span className="truncate font-mono text-sm font-bold text-slate-800">{selected.code}</span>
              <StatusBadge {...statusOf(selected, activeWindow)} />
            </div>
            {canEdit && (
              <Button size="sm" onClick={() => setEditing(true)}>Edit</Button>
            )}
          </div>
          <dl className="min-h-0 flex-1 overflow-y-auto px-5 py-2">
            {row('Instrument ID', selected.code)}
            {row('Building', placement.building ?? UNASSIGNED, !placement.building)}
            {row('Area', placement.area ?? UNASSIGNED, !placement.area)}
            {(attrs?.data ?? []).map((a) => (
              <div key={a.key} className="contents">
                {row(a.key, a.display ?? (a.value || '(empty)'), !a.display && !a.value)}
              </div>
            ))}
          </dl>
        </div>
      )}

      {selected && (
        <Dialog open={editing} onClose={() => setEditing(false)} className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Attributes — <span className="font-mono">{selected.code}</span></DialogTitle>
          </DialogHeader>
          <div className="px-5 pb-5">
            {editing && <AttributesPanel instrumentId={selected.id} profileId={selected.profileId} canEdit={canEdit} />}
          </div>
        </Dialog>
      )}
    </div>
  );
}
