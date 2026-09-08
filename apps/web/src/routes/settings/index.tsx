import { Fragment, useMemo, useState } from 'react';
import useSWR from 'swr';
import { ALL_RECORDS_PARAM, isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { apiClient } from '@/lib/api-client';
import { PageHeader } from '@/components/ui/page-header';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { AttributesPanel } from '@/routes/instruments/attributes-panel';

/**
 * Settings (2026-09-08). Operator: *"in side bar add settings, in that page show
 * the instrument details and attributes, there selected user role should edit
 * details, view details"*.
 *
 * ONE table of every instrument the viewer may see (instrument scope is applied
 * by the server on the list it reads), without the Instruments page's profile →
 * list → detail drill-down. A row expands to two things:
 *
 *  - its DETAILS, editable in place through the existing instrument update
 *    endpoint (same audit row as the detail page's Edit). Instrument ID is
 *    read-only: it is the MQTT identity. The superseded free-text `block` /
 *    `area` / `location` columns are neither shown nor written from here — the
 *    Block › Area column is the functional location and Location is the
 *    instrument's own `Location` ATTRIBUTE, exactly as the dashboard prints
 *    them, both read off `telemetry-overview` so nothing is re-derived here.
 *  - its ATTRIBUTES: the existing panel, mounted inside the row. It loads that
 *    instrument's attributes on demand and carries the whole §11 flow — the
 *    role's Attribute Access rule, mandatory remarks on a change, re-auth when
 *    the role requires it. Attributes are deliberately NOT table columns: the
 *    attributes endpoint is per instrument, and a hundred requests per page
 *    load is not a table.
 *
 * WHO: `settings.view` (INSTRUMENT_READ) shows the page and the expanded row
 * read-only; `settings.edit` (INSTRUMENT_UPDATE) turns the details form on and
 * hands the panel its edit flag, which the panel then narrows by Attribute
 * Access. Both are Roles & Access → Sidebar toggles. Presentation here; the
 * route gates are the control.
 */

interface Row {
  id: string; code: string; name: string; isActive: boolean; isGateway: boolean;
  profileId: string; profileName: string | null;
  instrumentType: string | null; manufacturer: string | null; model: string | null;
  serialNumber: string | null; description: string | null; expectedIntervalSec: number | null;
  lastSeenAt: string | null; functionalLocationId: string | null; createdAt: string;
}
interface OverviewRow { instrumentId: string; functionalLocationName?: string | null; locationAttribute?: string | null }
interface Draft {
  name: string; profileId: string; instrumentType: string; manufacturer: string; model: string;
  serialNumber: string; description: string; expectedIntervalSec: string; isActive: boolean;
}

const th = 'px-3 py-2 text-left text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-slate-600';
const td = 'px-3 py-2.5 align-top text-sm text-slate-700';

/** Empty states are worded APART, as on the dashboard: no functional location
 *  is "Unassigned"; an absent attribute is "Not set". */
const UNASSIGNED = 'Unassigned';
const NOT_SET = 'Not set';

function statusOf(r: Row, activeWindow: number): { tone: StatusTone; label: string } {
  if (!r.isActive) return { tone: 'idle', label: 'Disabled' };
  return isInstrumentReporting(r.lastSeenAt, r.expectedIntervalSec, activeWindow)
    ? { tone: 'ok', label: 'Reporting' }
    : { tone: 'warn', label: 'Not reporting' };
}

function draftOf(r: Row): Draft {
  return {
    name: r.name, profileId: r.profileId, instrumentType: r.instrumentType ?? '', manufacturer: r.manufacturer ?? '',
    model: r.model ?? '', serialNumber: r.serialNumber ?? '', description: r.description ?? '',
    expectedIntervalSec: r.expectedIntervalSec == null ? '' : String(r.expectedIntervalSec), isActive: r.isActive,
  };
}

export function SettingsPage() {
  const can = useCan();
  const { toast } = useToast();
  const { formatDateTime } = useDatetimeFormat();
  const canEdit = can('settings.edit');

  const { data, isLoading, error, mutate } = useSWR<{ data: Row[]; total: number }>(`/api/instruments?${ALL_RECORDS_PARAM}`);
  const { data: overview } = useSWR<{ data: OverviewRow[] }>('/api/instruments/telemetry-overview');
  const { data: profiles } = useSWR<{ data: { id: string; name: string }[] }>('/api/instrument-profiles');
  const { data: activityConfig } = useSWR<{ activeWindowMinutes?: number }>('/api/config/instrument-activity/current');
  const activeWindow = activityConfig?.activeWindowMinutes ?? INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;

  const placement = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    for (const o of overview?.data ?? []) m.set(o.instrumentId, o);
    return m;
  }, [overview]);

  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);

  const rows = useMemo(() => {
    const all = data?.data ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => {
      const p = placement.get(r.id);
      return [r.code, r.name, r.profileName, p?.functionalLocationName, p?.locationAttribute]
        .some((v) => (v ?? '').toLowerCase().includes(q));
    });
  }, [data, search, placement]);

  const toggle = (id: string) => {
    setDraft(null);
    setOpenId((cur) => (cur === id ? null : id));
  };

  const save = async (r: Row) => {
    if (!draft) return;
    setSaving(true);
    try {
      // `code` is absent on purpose — immutable server-side (MQTT identity). The
      // superseded block/area/location columns are absent too: omitted keys are
      // left unchanged by the update schema.
      await apiClient.put(`/api/instruments/${r.id}`, {
        name: draft.name, isActive: draft.isActive, profileId: draft.profileId,
        instrumentType: draft.instrumentType || null, manufacturer: draft.manufacturer || null,
        model: draft.model || null, serialNumber: draft.serialNumber || null,
        description: draft.description || null,
        expectedIntervalSec: draft.expectedIntervalSec ? Number(draft.expectedIntervalSec) : null,
      });
      setDraft(null);
      await mutate();
      toast.success('Instrument updated', `"${r.code}" saved.`);
    } catch (err: unknown) {
      toast.error('Update failed', (err as { message?: string })?.message ?? 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const field = (label: string, key: keyof Draft, type: 'text' | 'number' = 'text') => (
    <label className="block space-y-1 text-xs font-semibold text-slate-600">
      {label}
      <Input
        type={type}
        value={String(draft?.[key] ?? '')}
        onChange={(e) => setDraft((d) => (d ? { ...d, [key]: e.target.value } : d))}
        className="font-normal"
      />
    </label>
  );

  const readout = (label: string, value: string | number | null | undefined) => (
    <div>
      <dt className="text-xs font-semibold text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-800">{value === null || value === undefined || value === '' ? '—' : value}</dd>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader
        title="Settings"
        description="Every instrument's details and attributes in one table. Open a row to read or change them."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Settings' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        }
        actions={
          <Input
            type="search"
            aria-label="Search instruments"
            placeholder="Search ID, profile, area or location"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-72"
          />
        }
      />

      <div className="overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
        {error ? (
          <p className="px-5 py-6 text-sm text-red-700">The instruments could not be loaded. Try again.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead className="bg-slate-50">
                <tr>
                  <th className={th}>Instrument ID</th>
                  <th className={th}>Profile</th>
                  <th className={th}>Type</th>
                  <th className={th}>Block › Area</th>
                  <th className={th}>Location</th>
                  <th className={th}>Status</th>
                  <th className={th}>Last seen</th>
                  <th className={`${th} text-right`} />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {isLoading && (
                  <tr><td colSpan={8} className="px-4 py-4"><SkeletonRows rows={4} columns={8} /></td></tr>
                )}
                {!isLoading && rows.length === 0 && (
                  <tr><td colSpan={8} className="px-5 py-8 text-center text-sm text-slate-500">
                    {search ? 'No instruments match the search.' : 'No instruments registered yet.'}
                  </td></tr>
                )}
                {rows.map((r) => {
                  const p = placement.get(r.id);
                  const status = statusOf(r, activeWindow);
                  const open = openId === r.id;
                  const editing = open && draft !== null;
                  return (
                    <Fragment key={r.id}>
                      <tr className={open ? 'bg-slate-50/70' : 'hover:bg-slate-50/70'}>
                        <td className={`${td} font-mono font-semibold text-slate-800`}>{r.code}</td>
                        <td className={td}>{r.profileName ?? '—'}</td>
                        <td className={td}>{r.instrumentType ?? '—'}</td>
                        <td className={td}>{p?.functionalLocationName || <span className="text-slate-400">{UNASSIGNED}</span>}</td>
                        <td className={td}>{p?.locationAttribute || <span className="text-slate-400">{NOT_SET}</span>}</td>
                        <td className={td}><StatusBadge tone={status.tone} label={status.label} /></td>
                        <td className={`${td} whitespace-nowrap text-xs text-slate-500`}>{r.lastSeenAt ? formatDateTime(r.lastSeenAt) : '—'}</td>
                        <td className={`${td} whitespace-nowrap text-right`}>
                          <Button size="sm" variant="secondary" aria-expanded={open} onClick={() => toggle(r.id)}>
                            {open ? 'Hide details' : 'Show details'}
                          </Button>
                        </td>
                      </tr>
                      {open && (
                        <tr className="bg-slate-50/40">
                          <td colSpan={8} className="px-5 py-5">
                            <div className="grid gap-6 lg:grid-cols-2">
                              <section className="space-y-3">
                                <div className="flex items-center justify-between">
                                  <h3 className="text-sm font-bold text-slate-800">Details</h3>
                                  {canEdit && !editing && (
                                    <Button size="sm" onClick={() => setDraft(draftOf(r))}>Edit details</Button>
                                  )}
                                </div>
                                {editing ? (
                                  <form
                                    className="grid gap-3 sm:grid-cols-2"
                                    onSubmit={(e) => { e.preventDefault(); void save(r); }}
                                  >
                                    <div className="sm:col-span-2 text-xs text-slate-500">
                                      Instrument ID <span className="font-mono font-semibold text-slate-700">{r.code}</span> cannot be changed.
                                    </div>
                                    {field('Name', 'name')}
                                    <label className="block space-y-1 text-xs font-semibold text-slate-600">
                                      Profile
                                      <Select
                                        value={draft.profileId}
                                        onChange={(e) => setDraft((d) => (d ? { ...d, profileId: e.target.value } : d))}
                                        className="font-normal"
                                      >
                                        {(profiles?.data ?? []).map((pr) => <option key={pr.id} value={pr.id}>{pr.name}</option>)}
                                      </Select>
                                    </label>
                                    {field('Type', 'instrumentType')}
                                    {field('Manufacturer', 'manufacturer')}
                                    {field('Model', 'model')}
                                    {field('Serial number', 'serialNumber')}
                                    {field('Expected interval (seconds)', 'expectedIntervalSec', 'number')}
                                    {field('Description', 'description')}
                                    <div className="sm:col-span-2">
                                      <Toggle
                                        label="Enabled"
                                        checked={draft.isActive}
                                        onChange={(e) => setDraft((d) => (d ? { ...d, isActive: e.target.checked } : d))}
                                      />
                                    </div>
                                    <div className="flex gap-2 sm:col-span-2">
                                      <Button type="submit" size="sm" loading={saving}>Save details</Button>
                                      <Button type="button" size="sm" variant="secondary" onClick={() => setDraft(null)} disabled={saving}>Cancel</Button>
                                    </div>
                                  </form>
                                ) : (
                                  <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                                    {readout('Instrument ID', r.code)}
                                    {readout('Name', r.name)}
                                    {readout('Profile', r.profileName)}
                                    {readout('Type', r.instrumentType)}
                                    {readout('Manufacturer', r.manufacturer)}
                                    {readout('Model', r.model)}
                                    {readout('Serial number', r.serialNumber)}
                                    {readout('Expected interval (seconds)', r.expectedIntervalSec)}
                                    {readout('Description', r.description)}
                                    {readout('Block › Area', p?.functionalLocationName || UNASSIGNED)}
                                    {readout('Created', formatDateTime(r.createdAt))}
                                    {readout('Gateway', r.isGateway ? 'Yes' : 'No')}
                                  </dl>
                                )}
                              </section>
                              <section className="space-y-3">
                                <h3 className="text-sm font-bold text-slate-800">Attributes</h3>
                                <AttributesPanel instrumentId={r.id} profileId={r.profileId} canEdit={canEdit} />
                              </section>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
