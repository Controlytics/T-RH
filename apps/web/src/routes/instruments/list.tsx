import { useState, useEffect, useRef } from 'react';
import { Link, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { useCan } from '@/hooks/use-can';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { isInstrumentReporting, INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN } from '@digilog/shared';
import { themeGradient, themeGradientBr } from '@/lib/theme-styles';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Pagination } from '@/components/ui/pagination';
import { PageHero } from '@/components/ui/page-hero';
import { Toolbar } from '@/components/ui/toolbar';
import { Table, TableHeader, TableHead, TableBody, TableRow, TableCell } from '@/components/ui/table';
import { StatusBadge } from '@/components/ui/status-badge';
import { SkeletonRows } from '@/components/ui/skeleton';
import { LoadError } from '@/components/ui/load-error';

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
  const bar = tone === 'active' ? 'bg-emerald-500' : tone === 'inactive' ? 'bg-slate-400' : '';
  const dot = tone === 'active' ? 'bg-emerald-500' : tone === 'inactive' ? 'bg-slate-400' : '';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`group relative overflow-hidden rounded-[var(--radius-card)] border bg-white p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-[var(--elev-1)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400 ${
        active ? 'border-slate-400 shadow-[var(--elev-1)]' : 'border-slate-200'
      }`}
    >
      {tone === 'brand'
        ? <span className="absolute inset-x-0 top-0 h-1" style={themeGradient} />
        : <span className={`absolute inset-x-0 top-0 h-1 ${bar}`} />}
      <div className="flex items-center gap-2">
        {dot && <span className={`h-2 w-2 rounded-full ${dot}`} />}
        <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-slate-500">{label}</span>
      </div>
      <p className="mt-1 text-3xl font-bold tabular-nums text-slate-800">{value}</p>
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

  // `error` is read (audit 2026-10-03, WEB-6): without it a 500 or a
  // visibility-scope 403 rendered "No instruments registered yet" — a sentence
  // asserting nothing exists, to someone who merely could not read the list.
  const { data, error, isLoading } = useSWR<ListResponse>(`/api/instruments?${params}`);
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
      {/* UI v3 (2026-09-21): the shared band. A profile view crumbs back to
          the full list; the "Register" eyebrow and the description sentence
          went (labels, not prose). */}
      <PageHero
        title={profile?.name ?? 'Instruments'}
        crumbs={profileId
          ? [{ label: 'Dashboard', to: '/' }, { label: 'Instruments', to: '/instruments' }, { label: profile?.name ?? '…' }]
          : [{ label: 'Dashboard', to: '/' }, { label: 'Instruments' }]}
        actions={can('instruments.create') && (
          <>
            <Link to={profileId ? `/instruments/bulk?profileId=${profileId}` : '/instruments/bulk'}>
              <Button className="border border-white/30 bg-white/10 text-white hover:bg-white/20">Bulk upload</Button>
            </Link>
            <Link to={profileId ? `/instruments/new?profileId=${profileId}` : '/instruments/new'}>
              <Button className="bg-white text-slate-800 hover:bg-white/90">New instrument</Button>
            </Link>
          </>
        )}
      />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryTile label="Active" value={counts.active} tone="active" active={tileFilter === 'active'} onClick={() => toggle('active')} />
        <SummaryTile label="Inactive" value={counts.inactive} tone="inactive" active={tileFilter === 'inactive'} onClick={() => toggle('inactive')} />
        <SummaryTile label="Gateways" value={counts.gateway} tone="brand" active={tileFilter === 'gateway'} onClick={() => toggle('gateway')} />
      </div>
      <p className="-mt-4 text-xs text-slate-400">
        Counts describe the {rows.length} instrument{rows.length === 1 ? '' : 's'} on this page.
        Active means telemetry arrived within the instrument’s expected interval, or within{' '}
        {activeWindow} minute{activeWindow === 1 ? '' : 's'} when it declares none.
      </p>

      <Toolbar
        search={{ name: 'instrument-search', label: 'Search instruments', placeholder: 'Search name, code or serial…', value: search, onChange: setSearch }}
        filters={
          <Select className="w-40" value={active} onChange={(e) => { setActive(e.target.value); setPage(1); }}>
            <option value="">All statuses</option>
            <option value="true">Active</option>
            <option value="false">Inactive</option>
          </Select>
        }
        trailing={tileFilter && (
          <Button variant="ghost" size="sm" type="button" onClick={() => setTileFilter(null)}>
            Clear {tileFilter} filter
          </Button>
        )}
      />

      <Table>
          <TableHeader>
            <tr>
              <TableHead>Instrument ID</TableHead>
              <TableHead>Status</TableHead>
              <TableHead />
            </tr>
          </TableHeader>
          <TableBody>
            {isLoading && (
              <tr><td colSpan={3} className="px-4 py-4"><SkeletonRows rows={4} columns={3} /></td></tr>
            )}

            {/* The failure line, never the empty state, on a failed fetch. */}
            {!isLoading && error && (
              <tr><td colSpan={3} className="px-4 py-4"><LoadError what="instruments" error={error} /></td></tr>
            )}

            {!isLoading && !error && rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-14 text-center">
                  <div
                    className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-[var(--radius-card)] text-white shadow-[var(--elev-1)]"
                    style={themeGradientBr}
                  >
                    <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" />
                    </svg>
                  </div>
                  <p className="font-semibold text-slate-700">
                    {filtersActive ? 'No instruments match these filters' : 'No instruments registered yet'}
                  </p>
                  <p className="mt-1 text-sm text-slate-500">
                    {filtersActive
                      ? 'Clear a filter to widen the search.'
                      : 'Register a device to give it a token and a topic to report on.'}
                  </p>
                  {!filtersActive && can('instruments.create') && (
                    <Link to={profileId ? `/instruments/new?profileId=${profileId}` : '/instruments/new'} className="mt-4 inline-block">
                      <Button>Register the first instrument</Button>
                    </Link>
                  )}
                </TableCell>
              </TableRow>
            )}

            {!isLoading && rows.length > 0 && shown.length === 0 && (
              <TableRow>
                <TableCell colSpan={3} className="py-12 text-center text-sm text-slate-500">
                  Nothing on this page is {tileFilter === 'gateway' ? 'a gateway' : tileFilter}.
                </TableCell>
              </TableRow>
            )}

            {shown.map(({ row: r, reporting }) => (
              <TableRow key={r.id} className="group">
                <TableCell>
                  {/* The INSTRUMENT ID leads, with the name beneath.
                      `code` is the Instrument ID throughout this product — the
                      create form labels that field "Instrument ID *", the detail
                      page prints it under an "Instrument ID" heading, and the
                      Dashboard table column is headed the same. This list used to
                      lead with `name`, so the same instrument appeared as
                      "Instrument-1" here and "CWH-01" on the Dashboard, which read
                      as two different records. Keep these in step. */}
                  <Link to={`/instruments/${r.id}`} className="flex flex-col leading-tight">
                    <span className="flex items-center gap-2 font-mono font-semibold text-slate-800 group-hover:text-slate-900">
                      {r.code}
                      {r.isGateway && (
                        <span
                          className="rounded-md px-1.5 py-0.5 font-sans text-[0.625rem] font-bold uppercase tracking-wide text-white"
                          style={themeGradient}
                        >
                          Gateway
                        </span>
                      )}
                    </span>
                    <span className="text-xs text-slate-500">{r.name}</span>
                  </Link>
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap items-center gap-1.5">
                    {/* Hand-rolled dot-plus-word before this: the same construction
                        StatusBadge exists to provide, in its own greens. */}
                    <StatusBadge tone={reporting ? 'ok' : 'idle'} label={reporting ? 'Active' : 'Inactive'} />
                    {/* The ADMIN flag, which is a different fact: this device is
                        switched off, so it cannot report even if it wanted to.
                        Shown separately so a deliberate shutdown is never
                        mistaken for a dead device. */}
                    {!r.isActive && (
                      <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-amber-700 ring-1 ring-amber-200">
                        Disabled
                      </span>
                    )}
                  </span>
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    to={`/instruments/${r.id}`}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1.5 text-xs font-semibold text-slate-600 transition-colors hover:border-slate-300 hover:bg-slate-50"
                  >
                    Open
                    <svg className="h-3.5 w-3.5 transition-transform group-hover:translate-x-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                    </svg>
                  </Link>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

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
