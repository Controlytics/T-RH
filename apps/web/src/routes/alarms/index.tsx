import { useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useSensorWords, useAlarmTypeNames } from '@/hooks/use-failure-text';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import { Button } from '@/components/ui/button';
import { AcknowledgeDialog } from './acknowledge-dialog';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { deliverReport, deliveryToast } from '@/lib/report-delivery';
import { createReport } from '@/lib/pdf-report';
import {
  buildAlarmsReport, ALARM_REPORT_LEGEND, reportSeedPeriod, reportLevel,
} from './alarms-report';
import { PageHero } from '@/components/ui/page-hero';
import { Pagination } from '@/components/ui/pagination';
import { SkeletonRows } from '@/components/ui/skeleton';
import { AlarmStatCards } from './alarm-stat-cards';
import {
  AlarmFilters, EMPTY_FILTERS, hasAnyFilter, locationFilterId, useFilterScopeLabels,
  type AlarmFilterState,
} from './alarm-filters';
import {
  needsAcknowledgement, instrumentLabel, mapStatusTextsResponse,
  quadrantTone, localInputToIso, mapInactivityTextsResponse,
  type AlarmRow, type AlarmQuadrant, type AlarmStatusTextsResponse, type AlarmSortKey,
  type InactivityTextsResponse, type AlarmDisplayTexts,
} from './alarm-display';
// The table's presentation — banner, headers, state marker, status pill and
// every cell — is SHARED with the trend page's "Alarms in this period" widget
// (`routes/instruments/alarms-widget.tsx`). Two hand-written copies of one table
// is what let that widget key its status pill off the old `severity` field for a
// day after this page had fixed exactly that. See the module header for what it
// deliberately does NOT hold: this page's server-side filter/sort/count/page
// wiring is untouched by the sharing.
import {
  AlarmTableHead, Th, Stack, UnitLine, ALARM_ROW_CLASS, ALARM_CELL,
  ALARM_BANNER_SOLID, AlarmTableMessage,
  AlarmInstrumentCell, AlarmTypeCell, AlarmAreaCell, AlarmLocationCell, AlarmTimeCell,
  AlarmValueCell, AlarmLimitCell, AlarmClearedValueCell, AlarmStatusCell,
  AlarmDurationCell, AlarmAckByCell,
} from './alarm-table';

/**
 * Alarms — what the evaluator has raised, and who has answered for it.
 *
 * There is no create, edit or delete here by design: alarms are RAISED by the worker
 * and are regulated records. Rules are authored on Configuration → Alarm Rules.
 *
 * Filtering, sorting, counting and paging all happen ON THE SERVER
 * (`modules/alarms/list-query.ts`). They used to happen in this component over the
 * newest 500 rows, which meant the count boxes described a window rather than the
 * plant, and a date range could not reach past the oldest row fetched. The four
 * boxes and "showing N of M" now come from the same response and cannot disagree.
 */
export default function AlarmsPage() {
  const can = useCan();
  const { toast } = useToast();
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const { defaultLimit } = usePaginationDefaults();
  const [downloadOpen, setDownloadOpen] = useState(false);

  const [filters, setFilters] = useState<AlarmFilterState>(EMPTY_FILTERS);
  const scopeLabels = useFilterScopeLabels(filters);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [sort, setSort] = useState<AlarmSortKey>('raisedAt');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultLimit);
  const [target, setTarget] = useState<AlarmRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  // Typing must not fire a request per keystroke; every other filter is a
  // deliberate single act and is applied immediately.
  const search = useDebounced(filters.search, 300);

  // Any change to WHICH rows match invalidates the page number — page 4 of a
  // narrowed result is usually empty, and an empty table is read as "no alarms".
  useEffect(() => {
    setPage(1);
  }, [
    search, filters.from, filters.to, filters.type, filters.status,
    filters.blockId, filters.areaId, filters.instrumentId, pageSize,
  ]);

  const query = useMemo(() => {
    const qs = new URLSearchParams({
      page: String(page), pageSize: String(pageSize), sort, dir,
    });
    if (search) qs.set('search', search);
    if (filters.type) qs.set('type', filters.type);
    if (filters.status) qs.set('status', filters.status);
    // Block and Area are ONE axis: the narrower of the two is the whole filter,
    // since the Area picker only ever offers Areas inside the chosen Block.
    const locationId = locationFilterId(filters);
    if (locationId) qs.set('functionalLocationId', locationId);
    if (filters.instrumentId) qs.set('instrumentId', filters.instrumentId);
    // Resolved to an instant here, where the operator's clock is — see
    // localInputToIso. An unreadable value is simply not sent, so a half-typed
    // date does not 400 the page while the operator is still typing it.
    const from = localInputToIso(filters.from);
    const to = localInputToIso(filters.to);
    if (from) qs.set('from', from);
    if (to) qs.set('to', to);
    return qs.toString();
  }, [
    page, pageSize, sort, dir, search, filters.type, filters.status,
    filters.blockId, filters.areaId, filters.instrumentId, filters.from, filters.to,
  ]);

  const { data, isLoading, error, mutate } = useSWR<{
    data: AlarmRow[];
    total: number;
    counts: Record<AlarmQuadrant, number>;
  }>(`/api/alarms?${query}`, { keepPreviousData: true });

  const { data: summary, mutate: mutateSummary } = useSWR<{
    active: number; unacknowledged: number;
    instrumentsWithoutLimits?: number; instrumentsWithoutLimitsCodes?: string[];
    limitAlarmsEnabled?: boolean;
  }>('/api/alarms/summary');

  // Narrow, all-authenticated-users read — the `alarm-limits` config itself
  // (`/api/config/dynamic/alarm-limits`) is SUPER_ADMIN-only because most of it is
  // sensitive (the attribute-key mapping). `/status-texts` exposes only the
  // four wording strings, already defaulted server-side, so every operator sees the
  // configured wording instead of every non-SUPER_ADMIN 403ing into the fallback.
  //
  // The API payload uses `status*`-prefixed keys (mirroring the stored config
  // keys in alarm-limits.def.ts); `AlarmStatusTexts` (alarm-display.ts) uses the
  // unprefixed display-contract names `statusText()` reads. The two vocabularies
  // are deliberately different — `mapStatusTextsResponse()` is the one place
  // that reconciles them, and is unit-tested directly.
  const { data: statusTextsResponse } = useSWR<AlarmStatusTextsResponse>(
    '/api/config/alarm-limits/status-texts',
  );
  const statusTexts = statusTextsResponse ? mapStatusTextsResponse(statusTextsResponse) : undefined;

  // The three column wordings for an inactivity alarm, from its own narrow
  // all-authenticated-users read for the same reason as above — the
  // `inactivity-alarms` config itself is SUPER_ADMIN-only because `enabled` and
  // `graceMinutes` decide what fires as a regulated alarm.
  //
  // A SECOND fetch rather than three more keys on `/status-texts`: that endpoint's
  // contract is a narrow slice of the `alarm-limits` row, and these keys are not in
  // it. Undefined while it loads, which degrades to the shipped wording — never to
  // an empty cell.
  const { data: inactivityTextsResponse } = useSWR<InactivityTextsResponse>(
    '/api/config/inactivity-alarms/display-texts',
  );
  // The RS485 failure word, from its own narrow read route. Folded into ONE bag
  // with the inactivity wordings: these helpers are called from four surfaces and
  // a parameter per alarm source would have to be threaded through all of them
  // again the next time a source is added.
  const sensorWords = useSensorWords();
  const typeNames = useAlarmTypeNames();
  const inactivityTexts: AlarmDisplayTexts = {
    ...(inactivityTextsResponse ? mapInactivityTextsResponse(inactivityTextsResponse) : {}),
    sensorFailure: sensorWords.failure,
    outOfRange: sensorWords.outOfRange,
    typeNames,
  };

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  /**
   * THE GOVERNED PDF DOWNLOAD (operator, 2026-09-01), built to the supplied
   * `Alarm Report.pdf`.
   *
   * The chain is the one every report download in this product goes through:
   * the dialog collects a PERIOD and — as Configuration → Report Downloads says
   * for the Alarm Report (2026-10-01) — the remarks and the password, then
   * `deliverReport` either audits and saves (Direct) or sends the frozen
   * document for approval (Request). Fail-closed: a download that was never
   * recorded never happens.
   */
  // The API has NO pageSize ceiling since 2026-09-02 (lib/page-size.ts) — this is
  // now just the block size this loop walks in, not a limit imposed on it.
  const REPORT_PAGE = 500;
  const REPORT_MAX = 5000;   // what one printed report may cover

  /**
   * Fetch the WHOLE period, not the page on screen.
   *
   * The table is paged, so reusing its rows would print 25 alarms and title them
   * as the period. Pages are walked to `total`, capped at `REPORT_MAX`, and any
   * shortfall is DISCLOSED IN THE PDF by `truncationNote` — never silently, and
   * never in a toast, which does not survive printing.
   */
  const fetchAllForReport = async (period: { from: string; to: string }) => {
    const rows: AlarmRow[] = [];
    let grand = 0;
    for (let p = 1; rows.length < REPORT_MAX; p += 1) {
      const qs = new URLSearchParams({
        page: String(p), pageSize: String(REPORT_PAGE), sort, dir,
        // THE DIALOG'S PERIOD, not the page's Raised-between filter. The operator
        // may have widened it in the dialog they just confirmed, and the report
        // prints the range it covers, so the two must be the same one.
        from: period.from, to: period.to,
      });
      if (search.trim()) qs.set('search', search.trim());
      if (filters.type) qs.set('type', filters.type);
      if (filters.status) qs.set('status', filters.status);
      const locationId = locationFilterId(filters);
      if (locationId) qs.set('functionalLocationId', locationId);
      if (filters.instrumentId) qs.set('instrumentId', filters.instrumentId);

      const res = await apiClient.get<{ data: AlarmRow[]; total: number }>(`/api/alarms?${qs}`);
      grand = res.total ?? 0;
      rows.push(...(res.data ?? []));
      if (res.data.length < REPORT_PAGE || rows.length >= grand) break;
    }
    return { rows: rows.slice(0, REPORT_MAX), total: grand };
  };

  const runDownload = async (req: ReportDownloadRequest) => {
    /**
     * `datetime-local` gives ZONELESS wall-clock text. Sent raw the API would
     * resolve it in its OWN zone, so a report headed 08:00–20:00 could cover a
     * different twelve hours than the operator asked for — the same reason this
     * page's Raised-between filter goes through `localInputToIso`, and it must be
     * the same conversion or the report and the table disagree.
     */
    const period = {
      from: localInputToIso(req.period.from) ?? req.period.from,
      to: localInputToIso(req.period.to) ?? req.period.to,
      label: req.period.label,
    };

    {
      const { rows: all, total: grand } = await fetchAllForReport(period);

      const doc = await createReport({
        title: 'ALARM REPORT',
        // PORTRAIT (operator, 2026-09-01): landscape was too wide. The table fits
        // because the placement columns are only added at the scopes where they
        // actually vary — see EXTRA_COLUMNS.
        orientation: 'portrait',
        formatDateTime,
        reportKey: 'alarms',
        legend: ALARM_REPORT_LEGEND,
      });
      buildAlarmsReport(doc, {
        rows: all,
        total: grand,
        scope: {
          ...scopeLabels,
          // The Location ATTRIBUTE, and only when ONE instrument is in scope —
          // every row then shares it. Across a whole Block the field names no
          // single space, and a report that filled it in anyway would be stating
          // one instrument's location as the report's.
          locationName: filters.instrumentId ? (all[0]?.locationAttribute ?? '') : '',
        },
        period,
        fmt: { formatDate, formatTime },
        texts: inactivityTexts,
        level: reportLevel(filters),
      });
      // Direct or Request, as configured (2026-10-01). recordCount is what the PAPER shows, never `grand`: a record claiming
      // 3,000 alarms beside a document printing 500 would contradict itself.
      // The instruments are the ones the PRINTED alarms belong to — what scopes
      // who may see a request (2026-10-01); a report of no alarms is about none.
      const outcome = await deliverReport({
        kind: 'alarms', req, report: doc, reportType: 'Alarms', title: doc.getSnapshot().title,
        requestMeta: { period, recordCount: all.length, search: search.trim() || undefined },
        instrumentIds: [...new Set(all.map((a) => a.instrumentId))],
      });
      setDownloadOpen(false);
      toast.success(...deliveryToast(outcome));
    }
  };

  const counts = data?.counts ?? { 'active-unack': 0, 'active-ack': 0, 'cleared-unack': 0, 'cleared-ack': 0 };

  const acknowledge = async (reason: string, password: string) => {
    if (!target) return;
    setSubmitting(true);
    setDialogError('');
    try {
      await apiClient.postWithReauth(`/api/alarms/${target.id}/acknowledge`, { reason }, password);
      toast.success('Alarm acknowledged', `Signed for ${instrumentLabel(target)}.`);
      setTarget(null);
      await Promise.all([mutate(), mutateSummary()]);
    } catch (e) {
      // Kept in the dialog rather than a toast: the password is still on screen and the
      // operator needs to correct it in place. A 409 here means someone else signed first.
      setDialogError(e instanceof Error ? e.message : 'Could not acknowledge this alarm.');
    } finally {
      setSubmitting(false);
    }
  };

  /** Clicking a header sorts by it; clicking the sorted one reverses it. */
  const toggleSort = (key: AlarmSortKey) => {
    if (sort === key) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(key); setDir(key === 'raisedAt' || key === 'clearedAt' ? 'desc' : 'asc'); }
    setPage(1);
  };

  return (
    // NO padding here. `<main>` in app-layout already applies `p-3 sm:p-4 lg:p-6`,
    // so this page's own `p-6` was DOUBLE-padding it — ~48px of dead margin down
    // each side, which is why the table appeared not to reach the page edges while
    // the dashboard (which adds none) did. Removed 2026-08-29.
    <div>
      <PageHero
        className="mb-6"
        title="Alarms"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Alarms' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z" />
          </svg>
        }
        // The download exports exactly what the filters below select — Block,
        // Area, Instrument and the period — so it rides in the band as the
        // screen's one action. Icon only, as on the trend page.
        actions={<ExportMenu surface="alarms" iconOnly onExportPdf={() => setDownloadOpen(true)} />}
      />

      <div className="mb-5">
        <AlarmStatCards
          counts={counts}
          selected={filters.status}
          onSelect={(q) => setFilters((f) => ({ ...f, status: q }))}
        />
      </div>

      <div className="mb-5">
        <AlarmFilters
          value={filters}
          onChange={setFilters}
          advancedOpen={advancedOpen}
          onToggleAdvanced={() => setAdvancedOpen((o) => !o)}
        />
      </div>

      {summary?.limitAlarmsEnabled === false && (
        <div className="mb-3 rounded-lg border border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          Limit alarms are turned off, so no instrument limits are being checked.
          Turn them on in Configuration → Instrument Limit Alarms.
        </div>
      )}

      {/* Two DIFFERENT failures, worded differently on purpose.
          `keepPreviousData` means a failed REVALIDATION leaves the last good rows
          on screen with `error` set — reachable on every refocus. Calling that
          "could not be loaded" over a table full of rows is plainly false, and it
          trains the reader to ignore the banner. The rows are real; only their
          age is in doubt. A first load with no data is the other case, and there
          the table says nothing about the record at all. */}
      {error && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          {data
            ? 'Showing the last result that loaded — the alarm list could not be refreshed, so it may be out of date.'
            : `Could not load alarms. ${error instanceof Error ? error.message : ''}`}
        </div>
      )}

      <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[var(--elev-1)]">
        <div className="overflow-x-auto">
          <table className="tbl-grid w-full border-collapse text-[0.9375rem]">
            {/* The mock's dark banner, painted from the site theme rather than a
                hardcoded indigo, so this table follows all ten colour presets
                instead of being the one screen with a palette of its own. */}
            <AlarmTableHead>
              <tr>
                <Th sortKey="instrumentCode" sort={sort} dir={dir} onSort={toggleSort}>Instrument ID</Th>
                <Th sortKey="type" sort={sort} dir={dir} onSort={toggleSort}>Type</Th>
                {/* AREA and LOCATION are two DIFFERENT facts (operator,
                    2026-09-01) — the same pair, in the same order, as the
                    dashboard readings table. Area is the authoritative Block >
                    Area grouping; Location is the instrument's own free-text
                    `Location` attribute. Neither sorts: `ALARM_SORT_KEYS` has no
                    location key, and a header that reordered one page of a paged
                    result would claim a sort of the record it is not doing. Both
                    are SEARCHED on the server. */}
                <Th>Area</Th>
                <Th>Location</Th>
                <Th sortKey="raisedAt" sort={sort} dir={dir} onSort={toggleSort}>Raised</Th>
                {/* Stacked onto three lines DELIBERATELY. On one line these two were the
                    widest headings on the page and set their columns' width, which
                    pushed the Acknowledge button off the right of the screen
                    (operator, 2026-08-31). Separate blocks rather than a wrap, so
                    the break is the same at every viewport width. */}
                <Th><Stack>Generated</Stack><Stack>Value</Stack><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th>Limit</Th>
                <Th sortKey="clearedAt" sort={sort} dir={dir} onSort={toggleSort}>Cleared</Th>
                <Th><Stack>Cleared</Stack><Stack>Value</Stack><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th sortKey="status" sort={sort} dir={dir} onSort={toggleSort}>Status</Th>
                {/* H = hours, m = minutes. Abbreviated because the spelled-out
                    legend was the widest header on the page and pushed the table
                    past the viewport. */}
                <Th title="H = hours, m = minutes">Duration<UnitLine>(H/m)</UnitLine></Th>
                <Th><Stack>Acknowledged</Stack><Stack>by</Stack></Th>
                {/* Pinned to the right edge. Twelve columns do not fit a laptop
                    screen, and the ONE action on the page was the thing that fell
                    off the end of it — a table you must scroll sideways to
                    acknowledge an alarm from is a table nobody acknowledges alarms
                    from. Its own background, or the rows scroll through it. */}
                <Th className="sticky right-0 shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.25)]" style={ALARM_BANNER_SOLID} />
              </tr>
            </AlarmTableHead>
            <tbody className="divide-y divide-slate-100">
              {isLoading && !data && (
                <AlarmTableMessage colSpan={COLUMNS} className="px-4 py-4">
                  <SkeletonRows rows={5} columns={6} />
                </AlarmTableMessage>
              )}
              {/* `!error` is load-bearing. Without it a failed request renders
                  "No alarms have been raised." — a statement about the record —
                  underneath a banner saying the record could not be read. On a
                  monitoring screen that reads as "nothing is wrong". */}
              {error && rows.length === 0 && (
                <AlarmTableMessage colSpan={COLUMNS}>
                  The alarm list could not be loaded, so this table is not showing the current state.
                </AlarmTableMessage>
              )}
              {!isLoading && !error && rows.length === 0 && (
                <AlarmTableMessage colSpan={COLUMNS}>
                  {hasAnyFilter(filters)
                    ? 'No alarms match these filters.'
                    : 'No alarms have been raised.'}
                </AlarmTableMessage>
              )}
              {rows.map((a) => (
                <tr key={a.id} className={ALARM_ROW_CLASS}>
                  {/* The state marker rides on the leading cell — Instrument ID
                      here, Type in the trend widget, which drops this column as
                      redundant for a single-instrument view. */}
                  <AlarmInstrumentCell a={a} marker={quadrantTone(a)} />
                  <AlarmTypeCell a={a} texts={inactivityTexts} />
                  <AlarmAreaCell a={a} />
                  {/* `areaShown` because the Area cell is right beside it. Without
                      it this falls back to the functional location and the two
                      columns print the same string on every instrument with no
                      typed Location. */}
                  <AlarmLocationCell a={a} areaShown />
                  <AlarmTimeCell value={a.raisedAt} formatDate={formatDate} formatTime={formatTime} />
                  <AlarmValueCell a={a} texts={inactivityTexts} />
                  <AlarmLimitCell a={a} texts={inactivityTexts} />
                  <AlarmTimeCell
                    value={a.clearedAt}
                    formatDate={formatDate}
                    formatTime={formatTime}
                    emptyTitle="Still breaching — not cleared"
                  />
                  <AlarmClearedValueCell a={a} texts={inactivityTexts} />
                  <AlarmStatusCell a={a} texts={statusTexts} />
                  <AlarmDurationCell a={a} />
                  <AlarmAckByCell a={a} formatDateTime={formatDateTime} />
                  {/* The one cell the widget has no counterpart for: acknowledging
                      is a §11 signature, needing the gate, the re-auth dialog and
                      a revalidation afterwards, none of which a read-only widget
                      carries. It stays here, in the page that owns them. */}
                  <td className={`sticky right-0 bg-white ${ALARM_CELL} text-right shadow-[-8px_0_8px_-8px_rgba(15,23,42,0.15)] group-hover:bg-slate-50`}>
                    {needsAcknowledgement(a) && can('alarms.acknowledge') && (
                      <Button size="sm" variant="outline" onClick={() => { setDialogError(''); setTarget(a); }}>
                        Acknowledge
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="border-t border-slate-100">
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      </div>

      {/*
        The governed gate. It seeds from the page's Raised-between filter when one
        is set, so the dialog opens on the range already on screen; the operator
        may widen it, and THAT is the period the report covers and prints.
      */}
      <ReportDownloadDialog
        open={downloadOpen}
        reportName="Alarm Report"
        kind="alarms"
        initialPeriod={reportSeedPeriod(filters)}
        onCancel={() => setDownloadOpen(false)}
        onConfirm={runDownload}
      />

      <AcknowledgeDialog
        alarm={target}
        open={target !== null}
        submitting={submitting}
        error={dialogError}
        onSubmit={acknowledge}
        onClose={() => setTarget(null)}
        inactivityTexts={inactivityTexts}
      />
    </div>
  );
}

/**
 * THIRTEEN columns (Area added 2026-09-01). Read by every whole-width row — a
 * colSpan one short leaves a hairline of unpainted table beside the message, and
 * a test derives the expected value from the rendered header count so this
 * constant cannot silently drift from the `<thead>` above.
 */
const COLUMNS = 13;

/**
 * Hold a value still until typing stops.
 *
 * Local to this page rather than a shared hook: the only thing on the screen that
 * fires per keystroke is the search box, and a filter that queried the server on
 * every letter would put a request behind each one and let a slower response
 * overwrite a newer result.
 */
function useDebounced<T>(value: T, ms: number): T {
  const [held, setHeld] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setHeld(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return held;
}
