import { useState, useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { useCan } from '@/hooks/use-can';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { StatTile } from '@/components/ui/stat-tile';

/**
 * The instruments register, laid out around the question it is actually opened
 * to answer: WHICH DEVICES ARE TALKING?
 *
 * ── STATUS IS OBSERVED, NOT DECLARED (2026-08-07, operator request) ──
 * Active means telemetry is arriving: within the instrument's own expected
 * interval where it declares one, otherwise within the configurable window in
 * Configuration → Instrument Activity. It is NOT the admin enable/disable flag
 * — that is a separate fact, shown as its own "Disabled" badge, because
 * "nobody turned it off, it just stopped talking" and "we turned it off" call
 * for opposite responses.
 *
 * The previous table answered that with a raw "Last seen" datetime, leaving the
 * reader to subtract the current time and then compare against whatever
 * interval that particular instrument promised. Every row demanded arithmetic.
 * Now the signal state (see `./signal`) does it, the summary strip counts it,
 * and the strip's tiles are FILTERS — so noticing "3 silent" and acting on it
 * is one click, not a re-read of the table.
 *
 * Colour discipline: the brand gradient appears exactly twice (the header band
 * and the primary action). Everything else that is coloured is coloured because
 * it is a state, and those hues are fixed rather than themed — see `./signal`.
 */

interface InstrumentRow {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  tokenPrefix: string | null;
  lastSeenAt: string | null;
  lastSeenVia: string | null;
  expectedIntervalSec: number | null;
  isGateway: boolean;
  block: string | null;
  area: string | null;
  location: string | null;
  profileId: string;
}
interface ListResponse {
  data: InstrumentRow[];
  total: number; page: number; limit: number; totalPages: number;
}

/**
 * A tile in the summary strip. Clicking one applies its filter, and the active
 * one is ringed — the count and the filter are the same control, so a number
 * that surprises you is immediately explorable.
 */
function SummaryTile({
  label, value, tone, active, onClick,
}: {
  label: string;
  value: number | string;
  tone: 'active' | 'inactive' | 'brand';
  active: boolean;
  onClick: () => void;
}) {
  // These tiles are FILTER TOGGLES, so StatTile is composed inside the button
  // rather than used in place of it — the pressed state must stay legible, and a
  // gradient alone cannot carry it. Pressed = ring + lift; unpressed = flat.
  const toneFor = tone === 'active' ? 'positive' : tone === 'inactive' ? 'warning' : 'module';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`block w-full rounded-2xl text-left transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-[var(--mod-from)] ${
        active ? 'ring-4 ring-[var(--mod-from)]/40 ring-offset-2 -translate-y-0.5' : ''
      }`}
    >
      <StatTile
        label={label}
        value={<span className="tabular-nums">{value}</span>}
        tone={toneFor}
        // The filter state is also stated in words, because a ring is a weak
        // signal and colour on its own is never allowed to carry meaning here.
        icon={active ? <span className="text-[10px] font-bold uppercase tracking-wider">Filtered</span> : null}
      />
    </button>
  );
}

export function InstrumentListPage() {
  const can = useCan();
  const paginationOptions = usePaginationConfig();

  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [active, setActive] = useState('');
  /**
   * Reporting status is computed in the browser from `lastSeenAt` +
   * `expectedIntervalSec` + the configured window, so this filter applies to
   * the page in hand rather than being sent to the API. The tile counts say "on
   * this page" for the same reason — a count that silently described only 10 of
   * 240 rows would be a lie.
   */
  const [tileFilter, setTileFilter] = useState<'active' | 'inactive' | 'gateway' | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    debounceRef.current = setTimeout(() => { setDebouncedSearch(search); setPage(1); }, 300);
    return () => clearTimeout(debounceRef.current);
  }, [search]);

  // Scoped to one profile when reached via /instruments/profiles/:profileId.
  const { profileId } = useParams<{ profileId: string }>();

  const params = new URLSearchParams({ page: String(page), limit: String(perPage) });
  if (debouncedSearch) params.set('search', debouncedSearch);
  if (active) params.set('isActive', active);
  // Sent to the SERVER, not applied to the rows here: filtering client-side left
  // `total` counting every instrument, so an empty profile's footer read
  // "Showing 1–10 of 15" over an empty table.
  if (profileId) params.set('profileId', profileId);

  const { data, isLoading } = useSWR<ListResponse>(`/api/instruments?${params}`);
  const { data: profile } = useSWR<{ id: string; name: string; description: string | null }>(
    profileId ? `/api/instrument-profiles/${profileId}` : null,
  );
  // The fallback window for instruments that declare no expected interval.
  const { data: activityConfig } = useSWR<{ activeWindowMinutes?: number }>('/api/config/instrument-activity/current');
  const activeWindow = activityConfig?.activeWindowMinutes ?? INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN;
  const rows = data?.data ?? [];

  const withStatus = rows.map((r) => ({
    row: r,
    reporting: isInstrumentReporting(r.lastSeenAt, r.expectedIntervalSec, activeWindow),
  }));
  const counts = {
    active: withStatus.filter((r) => r.reporting).length,
    inactive: withStatus.filter((r) => !r.reporting).length,
    gateway: withStatus.filter((r) => r.row.isGateway).length,
  };
  const shown = tileFilter
    ? withStatus.filter((r) => (
        tileFilter === 'gateway' ? r.row.isGateway
        : tileFilter === 'active' ? r.reporting
        : !r.reporting))
    : withStatus;

  const toggle = (f: 'active' | 'inactive' | 'gateway') => setTileFilter((cur) => (cur === f ? null : f));
  const filtersActive = Boolean(debouncedSearch || active);

  return (
    <div className="space-y-6">
      {/* The one place the brand gradient is spent on this page. */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-[var(--mod-from)] to-[var(--mod-to)] p-6 text-white shadow-lg">
        <div className="relative z-10 flex flex-wrap items-start justify-between gap-4">
          <div>
            {profileId ? (
              <Link to="/instruments" className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70 hover:text-white">
                ← All profiles
              </Link>
            ) : (
              <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">Register</p>
            )}
            <h1 className="mt-1 text-3xl font-bold">{profile?.name ?? 'Instruments'}</h1>
            <p className="mt-1 text-sm text-white/80">
              {profile?.description
                ?? 'Every device registered to report into this system — and whether it is reporting.'}
            </p>
          </div>
          {can('instruments.create') && (
            <div className="flex flex-wrap gap-2">
              <Link to={profileId ? `/instruments/bulk?profileId=${profileId}` : '/instruments/bulk'}>
                <Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">
                  Bulk upload
                </Button>
              </Link>
              <Link to={profileId ? `/instruments/new?profileId=${profileId}` : '/instruments/new'}>
                <Button className="surface-plain bg-white text-slate-800 hover:bg-white/90">New instrument</Button>
              </Link>
            </div>
          )}
        </div>
        {/* Ambient mast motif — the page's own vocabulary, not generic blobs. */}
        <div aria-hidden="true" className="pointer-events-none absolute -right-4 bottom-0 flex items-end gap-2 opacity-15">
          {[24, 44, 68, 96, 120].map((h) => (
            <span key={h} className="surface-plain w-4 rounded-t-md bg-white" style={{ height: h }} />
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryTile label="Active" value={counts.active} tone="active" active={tileFilter === 'active'} onClick={() => toggle('active')} />
        <SummaryTile label="Inactive" value={counts.inactive} tone="inactive" active={tileFilter === 'inactive'} onClick={() => toggle('inactive')} />
        <SummaryTile label="Gateways" value={counts.gateway} tone="brand" active={tileFilter === 'gateway'} onClick={() => toggle('gateway')} />
      </div>
      <p className="-mt-4 text-xs text-slate-600">
        Counts describe the {rows.length} instrument{rows.length === 1 ? '' : 's'} on this page.
        Active means telemetry arrived within the instrument’s expected interval, or within{' '}
        {activeWindow} minute{activeWindow === 1 ? '' : 's'} when it declares none.
      </p>

      <div className="rounded-2xl border border-border-tint bg-surface p-4">
        <div className="flex flex-wrap gap-3">
          <Input
            className="w-64"
            placeholder="Search name, code or serial…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Select className="w-40" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
          {tileFilter && (
            <button
              type="button"
              onClick={() => setTileFilter(null)}
              className="rounded-lg border border-border-tint bg-surface-raised px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-surface-alt"
            >
              Clear {tileFilter} filter
            </button>
          )}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border-tint bg-surface shadow-soft">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-[var(--mod-table-head)] text-left">
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white">Instrument</th>
              <th className="px-4 py-3 text-[11px] font-semibold uppercase tracking-wider text-white">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border-tint">
            {isLoading && (
              <tr><td colSpan={3} className="py-10 text-center text-slate-600">Loading…</td></tr>
            )}

            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-14 text-center">
                  <div
                    className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[var(--mod-from)] to-[var(--mod-to)] text-white shadow-md"
                  >
                    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                    </svg>
                  </div>
                  <p className="font-semibold text-slate-700">
                    {filtersActive ? 'No instruments match these filters' : 'No instruments registered yet'}
                  </p>
                  <p className="mt-1 text-sm text-slate-600">
                    {filtersActive
                      ? 'Clear a filter to widen the search.'
                      : 'Register a device to give it a token and a topic to report on.'}
                  </p>
                  {!filtersActive && can('instruments.create') && (
                    <Link to={profileId ? `/instruments/new?profileId=${profileId}` : '/instruments/new'} className="mt-4 inline-block">
                      <Button>Register the first instrument</Button>
                    </Link>
                  )}
                </td>
              </tr>
            )}

            {!isLoading && rows.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-12 text-center text-sm text-slate-600">
                  Nothing on this page is {tileFilter === 'gateway' ? 'a gateway' : tileFilter}.
                </td>
              </tr>
            )}

            {shown.map(({ row: r, reporting }) => (
              <tr key={r.id} className="group odd:bg-surface even:bg-surface-alt transition-colors hover:bg-surface-alt">
                <td className="px-4 py-3">
                  <Link to={`/instruments/${r.id}`} className="flex flex-col leading-tight">
                    <span className="flex items-center gap-2 font-semibold text-slate-800 group-hover:text-slate-900">
                      {r.name}
                      {r.isGateway && (
                        <span
                          className="rounded-md bg-gradient-to-r from-[var(--mod-from)] to-[var(--mod-to)] px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white"
                        >
                          Gateway
                        </span>
                      )}
                    </span>
                    <span className="font-mono text-xs text-slate-600">{r.code}</span>
                  </Link>
                </td>
                <td className="px-4 py-3">
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
                        reporting
                          ? 'bg-emerald-700 text-white'
                          : 'bg-slate-600 text-white'
                      }`}
                    >
                      <span className={`h-1.5 w-1.5 rounded-full ${reporting ? 'bg-emerald-200' : 'bg-slate-300'}`} />
                      {reporting ? 'Active' : 'Inactive'}
                    </span>
                    {/* The ADMIN flag, which is a different fact: this device is
                        switched off, so it cannot report even if it wanted to.
                        Shown separately so a deliberate shutdown is never
                        mistaken for a dead device. */}
                    {!r.isActive && (
                      <span className="inline-flex items-center rounded-full bg-amber-700 px-2 py-0.5 text-[11px] font-semibold text-white">
                        Disabled
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-right">
                  <Link
                    to={`/instruments/${r.id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-border-tint bg-surface-raised px-2.5 py-1.5 text-xs font-semibold text-[var(--mod-muted)] transition-colors hover:border-[var(--mod-from)] hover:bg-surface-alt"
                  >
                    Open
                    <svg className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Pagination
        page={page}
        pageSize={perPage}
        totalItems={data?.total ?? 0}
        onPageChange={setPage}
        onPageSizeChange={(n) => { setPerPage(n); setPage(1); }}
        pageSizeOptions={paginationOptions}
      />
    </div>
  );
}
