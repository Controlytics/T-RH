import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import useSWR from 'swr';
import { Activity } from 'lucide-react';
import {
  ALL_RECORDS, INTERVALS, coerceReading, formatDecimals, isOutOfRange, isSensorFailureValue,
} from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { Pagination } from '@/components/ui/pagination';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useSensorWords } from '@/hooks/use-failure-text';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { apiClient } from '@/lib/api-client';
import { logReportExport } from '@/lib/report-export-log';
import type { OverviewRow } from '@/routes/dashboard/use-telemetry';
import { useTrendPeriod, TREND_PRESETS } from './use-trend-data';
import { usePanelToolbarSlot } from '@/routes/dashboard/panel-card';
import { pillTone, rowTone, ROW_ACCENT, PILL_CLASS, FAULT_PILL, type PillTone } from './timeseries-table-card';
import { fetchDataReportRows, slotExtremes } from './data-report-fetch';
import { renderInstrumentHistoryReport, type DataReportInput } from './trend-report';
import { resolveBlockArea } from './data-report';
import {
  scopeIdFor, areasOf, effectiveSelection, toggleSelection, scopeNames,
  type LocationNode, type ScopedInstrument,
} from './history-selection';

/**
 * The Instruments page's HISTORY widget (operator, 2026-09-05): *"same like
 * trends page time series … provide Block and Area and instrument selection
 * … Area wise instruments history report … and also multiple selection and
 * download report for only selected instruments"*.
 *
 * Three parts, each with one job:
 *  - the SELECTION row — Block, Area, and a tick list of the instruments in
 *    scope. Everything in scope is selected until something is unticked
 *    (`history-selection.ts` holds the rules; the Block → Areas expansion is
 *    the SERVER's, through `/api/instruments?functionalLocationId=`).
 *  - the READINGS table — the merged, paged, newest-first readings of the
 *    selection over the chosen period, from `/api/instruments/telemetry-history`
 *    (pivoted server-side so a page cannot split an instant). Each row is
 *    judged with ITS OWN instrument's limits, precision and span, read from
 *    `telemetry-overview` — never a site-wide guess, since two instruments in
 *    one Area can carry different specs.
 *  - the DOWNLOAD — the Data Report for every selected instrument, one
 *    section each (`renderInstrumentHistoryReport`), through the same
 *    governed dialog, re-auth and audit row as every other report. Each
 *    instrument is read in turn and the dialog says which one it is on.
 *
 * Period and interval share `useTrendPeriod`'s URL state with the trend page,
 * so the same presets, the same custom range and the same interval keys apply
 * — one vocabulary for "what period is this" across the two screens.
 */

interface HistoryRow { instrumentId: string; ts: string; values: Record<string, unknown> }

const th = 'px-4 py-3 text-left text-[0.6875rem] font-bold uppercase tracking-[0.08em] text-slate-600';

/**
 * `embedded` — rendered inside a dashboard `PanelCard` (2026-09-05, operator:
 * *"all instruments report widget comes in dashboard … below the all
 * instruments readings table"*). The card owns the title, so the widget's own
 * header is dropped, and its Block / Area / Interval controls and the download
 * ride in the card header through `usePanelToolbarSlot()` — the same portal
 * the readings table and the alarms panel use, because a panel's controls sit
 * beside its title, not on a second row. The period presets and the custom
 * range stay in the body: seven buttons and two date inputs do not fit a
 * header that must not wrap. When there is no slot (rendered bare, as in its
 * tests) the toolbar renders inline where the header would have been.
 */
export function InstrumentHistoryWidget({ embedded = false }: { embedded?: boolean } = {}) {
  const { period, setPreset, setCustom, setInterval } = useTrendPeriod();
  const toolbarSlot = usePanelToolbarSlot();
  const paginationOptions = usePaginationConfig();
  const [blockId, setBlockId] = useState('');
  const [areaId, setAreaId] = useState('');
  // NOTHING is selected until a Block or Area is chosen (then everything in
  // it is). With no scope the list is the whole plant, and "everything
  // selected by default" would fire a plant-wide history query for every
  // visitor of the Instruments page, on a page people open constantly.
  const [selected, setSelected] = useState<Set<string> | null>(new Set());
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(paginationOptions[0]);
  const [pendingDownload, setPendingDownload] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const reauth = useReauth();
  const sensorWords = useSensorWords();
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();

  const { data: treeData } = useSWR<{ data: LocationNode[] }>('/api/functional-locations');
  const tree = treeData?.data ?? [];
  const areas = areasOf(tree, blockId);

  // The instruments in scope, from the list route — which applies the caller's
  // visibility and expands a Block to its Areas. Ask for every record: this
  // list is a picker, and a picker that shows page one of an Area is a picker
  // that silently omits the rest.
  const scopeId = scopeIdFor(blockId, areaId);
  const instQs = new URLSearchParams({ limit: String(ALL_RECORDS) });
  if (scopeId) instQs.set('functionalLocationId', scopeId);
  const { data: instData } = useSWR<{ data: ScopedInstrument[] }>(`/api/instruments?${instQs}`);
  const inScope = useMemo(() => instData?.data ?? [], [instData]);

  // Per-instrument keys, limits, precision and span — the server's resolution,
  // one request for the whole plant.
  const { data: overviewData } = useSWR<{ data: OverviewRow[] }>('/api/instruments/telemetry-overview');
  const overviewById = useMemo(() => {
    const m = new Map<string, OverviewRow>();
    for (const r of overviewData?.data ?? []) m.set(r.instrumentId, r);
    return m;
  }, [overviewData]);

  const chosen = effectiveSelection(inScope, selected);
  const chosenIds = chosen.map((i) => i.id);

  // A scope change resets the tick list and the page: ticks from another Area
  // must not survive as hidden state, and page 3 of the old selection is
  // usually past the end of the new one. A chosen Block or Area starts with
  // everything in it selected; no scope starts with nothing.
  useEffect(() => { setSelected(scopeId ? null : new Set()); setPage(1); }, [scopeId]);
  useEffect(() => { setPage(1); }, [period.from, period.to, selected]);

  const histQs = new URLSearchParams({
    instrumentIds: chosenIds.join(','),
    from: period.from, to: period.to,
    limit: String(pageSize), offset: String((page - 1) * pageSize),
  });
  const { data: hist, isLoading: histLoading, error: histError } = useSWR<{ data: HistoryRow[]; total: number }>(
    chosenIds.length ? `/api/instruments/telemetry-history?${histQs}` : null,
  );
  const rows = hist?.data ?? [];
  const total = hist?.total ?? 0;
  const byId = useMemo(() => new Map(inScope.map((i) => [i.id, i])), [inScope]);

  const runDownload = async (req: ReportDownloadRequest) => {
    const targets = effectiveSelection(inScope, selected);
    if (targets.length === 0) throw new Error('Select at least one instrument to report on.');
    const reportPeriod = { from: req.period.from, to: req.period.to, label: req.period.label };
    const interval = req.intervalMs !== undefined ? req.intervalMs : period.intervalMs;
    const fmt = { formatDate, formatTime };
    try {
      await reauth.executeWithResult('DOWNLOAD_REPORT', async (password) => {
        const sections: DataReportInput[] = [];
        for (const [i, inst] of targets.entries()) {
          setProgress(`Reading ${inst.code} (${i + 1} of ${targets.length})…`);
          const ov = overviewById.get(inst.id);
          const tempKey = ov?.temperature?.key ?? null;
          const humidKey = ov?.humidity?.key ?? null;
          const slotKeys = [tempKey, humidKey].filter((k): k is string => k !== null);
          const fetched = await fetchDataReportRows({
            instrumentId: inst.id, from: reportPeriod.from, to: reportPeriod.to, intervalMs: interval, slotKeys,
          });
          sections.push({
            scope: {
              ...resolveBlockArea(tree, inst.functionalLocationId ?? null),
              locationName: ov?.locationAttribute ?? '',
              instrumentLabel: inst.code,
            },
            period: reportPeriod, fmt, formatDateTime,
            temp: {
              key: tempKey, min: ov?.limits?.tempMin, max: ov?.limits?.tempMax,
              decimals: ov?.decimals.temperature ?? 1,
              rangeLow: ov?.rangeBounds?.temperatureLow ?? null, rangeHigh: ov?.rangeBounds?.temperatureHigh ?? null,
              ...slotExtremes(fetched.summaries, tempKey),
            },
            rh: {
              key: humidKey, min: ov?.limits?.rhMin, max: ov?.limits?.rhMax,
              decimals: ov?.decimals.humidity ?? 0,
              rangeLow: ov?.rangeBounds?.humidityLow ?? null, rangeHigh: ov?.rangeBounds?.humidityHigh ?? null,
              ...slotExtremes(fetched.summaries, humidKey),
            },
            rows: fetched.rows, intervalMs: interval, coverage: fetched.coverage, words: sensorWords,
          });
        }
        setProgress('Building the report…');
        const report = await renderInstrumentHistoryReport({
          scope: scopeNames(tree, blockId, areaId),
          period: reportPeriod, intervalMs: interval, fmt, formatDateTime,
          instruments: sections,
        });
        // Fail-closed: the audit write happens BEFORE the file is saved.
        await logReportExport({
          reportType: 'Instrument History', format: 'PDF',
          recordCount: sections.reduce((n, s) => n + s.rows.length, 0),
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          search: `${targets.length} instrument${targets.length === 1 ? '' : 's'}: ${targets.map((t) => t.code).join(', ')}`,
          remarks: req.remarks, password,
        });
        const stamp = new Date().toISOString().slice(0, 10);
        report.save(`instrument-history-${stamp}.pdf`);
      });
      setPendingDownload(false);
    } catch (e: any) {
      // A cancelled reauth prompt is not a failure. Any other error rethrows so
      // the dialog surfaces it and stays open.
      if (e?.error === 'REAUTH_CANCELLED') { setPendingDownload(false); return; }
      throw e;
    } finally {
      setProgress(null);
    }
  };

  const fromLocal = toLocalInput(period.from);
  const toLocal = toLocalInput(period.to);

  const subtitle = chosen.length === 0
    ? 'Choose a Block or Area, or tick instruments, to see their readings'
    : `${chosen.length} instrument${chosen.length === 1 ? '' : 's'} · ${period.label}`;

  // Block, Area, Interval and the download — the controls that fit a card
  // header. One group, `flex-nowrap`, so the panel header stays one row.
  const compactToolbar = (
    <div className="flex flex-nowrap items-center gap-2">
      <Select
        selectSize="sm"
        value={blockId}
        aria-label="Block"
        onChange={(e) => { setBlockId(e.target.value); setAreaId(''); }}
      >
        <option value="">All blocks</option>
        {tree.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </Select>
      <Select
        selectSize="sm"
        value={areaId}
        aria-label="Area"
        disabled={!blockId}
        onChange={(e) => setAreaId(e.target.value)}
      >
        <option value="">{blockId ? 'All areas' : 'Choose a block first'}</option>
        {areas.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
      <select
        value={period.intervalMs ?? ''}
        onChange={(e) => setInterval(e.target.value === '' ? null : Number(e.target.value))}
        className="ctl ctl-sm"
        aria-label="History interval"
      >
        {INTERVALS.map((i) => (
          <option key={i.value} value={i.seconds === null ? '' : i.seconds * 1000}>{i.label}</option>
        ))}
      </select>
      <ExportMenu
        surface="instrument-history"
        iconOnly
        busy={pendingDownload}
        onExportPdf={() => setPendingDownload(true)}
      />
    </div>
  );
  const toolbarInHeader = embedded && toolbarSlot !== null;

  return (
    <section
      data-testid="history-widget"
      className={embedded
        ? 'flex flex-col'
        : 'overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]'}
    >
      {toolbarInHeader ? createPortal(compactToolbar, toolbarSlot) : (
        <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 items-center gap-3.5">
            {!embedded && (
              <span
                className="grid h-12 w-12 shrink-0 place-items-center rounded-full"
                style={{
                  backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 14%, #ffffff)',
                  color: 'var(--theme-primary, #4f46e5)',
                }}
                aria-hidden="true"
              >
                <Activity className="h-6 w-6" />
              </span>
            )}
            <div className="min-w-0">
              {!embedded && (
                <h3 className="truncate text-lg font-bold tracking-tight text-slate-900">Instrument History</h3>
              )}
              <p className="mt-0.5 truncate text-[0.8125rem] text-slate-500">{subtitle}</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">{compactToolbar}</div>
        </header>
      )}

      {/* The period row: presets and the custom range. */}
      <div className="flex flex-wrap items-end gap-4 border-t border-slate-100 px-5 py-4">
        {toolbarInHeader && (
          <p className="w-full text-[0.8125rem] text-slate-500" data-testid="history-subtitle">{subtitle}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          {TREND_PRESETS.map((p) => (
            <Button key={p.label} size="sm" variant={period.label === p.label ? 'default' : 'secondary'} onClick={() => setPreset(p.ms)}>
              {p.label}
            </Button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          From
          <input
            type="datetime-local"
            value={fromLocal}
            onChange={(e) => e.target.value && setCustom(new Date(e.target.value).toISOString(), period.to)}
            className="ctl ctl-sm font-mono tabular-nums [color-scheme:light]"
            aria-label="History from"
          />
        </label>
        <label className="flex items-center gap-1.5 text-xs text-slate-600">
          To
          <input
            type="datetime-local"
            value={toLocal}
            onChange={(e) => e.target.value && setCustom(period.from, new Date(e.target.value).toISOString())}
            className="ctl ctl-sm font-mono tabular-nums [color-scheme:light]"
            aria-label="History to"
          />
        </label>
      </div>

      {/* The tick list. Everything in scope is selected until something is
          unticked; the count says what a download would cover. */}
      <div className="border-t border-slate-100 px-5 py-3">
        <div className="mb-2 flex flex-wrap items-center gap-3 text-xs text-slate-600">
          <span className="font-semibold uppercase tracking-[0.08em]">Instruments</span>
          <span data-testid="history-selection-count">
            {chosen.length} of {inScope.length} selected
          </span>
          {selected !== null && (
            <button type="button" className="text-[var(--theme-primary,#4f46e5)] hover:underline" onClick={() => setSelected(null)}>
              Select all
            </button>
          )}
          {selected === null && inScope.length > 0 && (
            <button type="button" className="text-[var(--theme-primary,#4f46e5)] hover:underline" onClick={() => setSelected(new Set())}>
              Clear
            </button>
          )}
        </div>
        {inScope.length === 0 ? (
          <p className="text-sm text-slate-500">No instruments in this scope.</p>
        ) : (
          <div className="grid max-h-40 grid-cols-2 gap-x-4 gap-y-1 overflow-y-auto sm:grid-cols-3 lg:grid-cols-5">
            {inScope.map((i) => (
              <Checkbox
                key={i.id}
                label={i.code}
                checked={selected === null || selected.has(i.id)}
                onChange={() => setSelected(toggleSelection(inScope, selected, i.id))}
              />
            ))}
          </div>
        )}
      </div>

      {/* The merged readings. */}
      {chosenIds.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-4 text-sm text-slate-500">Select at least one instrument.</p>
      ) : histError ? (
        <p className="border-t border-slate-100 px-6 py-4 text-sm text-red-700">The readings could not be loaded. Try again.</p>
      ) : !histLoading && rows.length === 0 ? (
        <p className="border-t border-slate-100 px-6 py-4 text-sm text-slate-500">No readings in this period.</p>
      ) : (
        <div className="overflow-x-auto border-t border-slate-100">
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ backgroundColor: 'color-mix(in srgb, var(--theme-primary, #4f46e5) 8%, #ffffff)' }}>
                <th scope="col" className={`${th} pl-6`}>Instrument</th>
                <th scope="col" className={th}>Timestamp</th>
                <th scope="col" className={`${th} !text-center`}>Temperature (°C)</th>
                <th scope="col" className={`${th} !text-center`}>Humidity (%RH)</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const ov = overviewById.get(row.instrumentId);
                const inst = byId.get(row.instrumentId);
                const temp = judge(row.values, ov?.temperature?.key ?? null, ov?.limits?.tempMin, ov?.limits?.tempMax,
                  ov?.rangeBounds?.temperatureLow ?? null, ov?.rangeBounds?.temperatureHigh ?? null);
                const rh = judge(row.values, ov?.humidity?.key ?? null, ov?.limits?.rhMin, ov?.limits?.rhMax,
                  ov?.rangeBounds?.humidityLow ?? null, ov?.rangeBounds?.humidityHigh ?? null);
                const tone = rowTone([temp.tone, rh.tone], temp.fault !== null || rh.fault !== null);
                return (
                  <tr key={`${row.instrumentId}|${row.ts}`} data-testid="history-row" data-tone={tone}
                    className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50/70">
                    <td className="relative py-3.5 pl-6 pr-4">
                      <span className={`absolute bottom-1 left-0 top-1 w-1 rounded-r-sm ${ROW_ACCENT[tone]}`} aria-hidden="true" />
                      <span className="flex items-center gap-3">
                        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ROW_ACCENT[tone]}`} aria-hidden="true" />
                        <span className="min-w-0">
                          <span className="block text-sm font-semibold text-slate-800">{inst?.code ?? ov?.code ?? row.instrumentId}</span>
                          {ov?.locationAttribute && (
                            <span className="block truncate text-xs text-slate-500">{ov.locationAttribute}</span>
                          )}
                        </span>
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-sm text-slate-700">{formatDateTime(row.ts)}</td>
                    <HistoryValueCell judged={temp} decimals={ov?.decimals.temperature ?? 1} words={sensorWords} />
                    <HistoryValueCell judged={rh} decimals={ov?.decimals.humidity ?? 0} words={sensorWords} />
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {chosenIds.length > 0 && total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          totalItems={total}
          onPageChange={setPage}
          onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          pageSizeOptions={paginationOptions}
        />
      )}

      <ReportDownloadDialog
        open={pendingDownload}
        reportName="Instrument History"
        showPeriod
        showInterval
        initialPeriod={{ from: period.from, to: period.to, label: period.label }}
        initialIntervalMs={period.intervalMs}
        progress={progress}
        onCancel={() => setPendingDownload(false)}
        onConfirm={runDownload}
      />
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Download Report"
      />
    </section>
  );
}

/** One slot of one row, judged with ITS instrument's own bounds. */
interface Judged {
  value: number | null;
  tone: PillTone;
  /** `'failure'` for a non-numeric reading, `'range'` for one outside the span. */
  fault: 'failure' | 'range' | null;
}

/**
 * The same precedence as the trend page's `ValueCell`: out of span first (it IS
 * a number, it is not a measurement), then a non-numeric reading, then the
 * number judged against the spec. A slot the instrument has no key for is
 * "no reading".
 */
export function judge(
  values: Record<string, unknown>,
  key: string | null,
  min: number | null | undefined,
  max: number | null | undefined,
  rangeLow: number | null,
  rangeHigh: number | null,
): Judged {
  if (!key || !(key in values)) return { value: null, tone: 'unjudged', fault: null };
  const raw = values[key];
  const n = coerceReading(raw);
  if (n === null) {
    return { value: null, tone: 'unjudged', fault: isSensorFailureValue(raw) ? 'failure' : null };
  }
  if (isOutOfRange(n, rangeLow, rangeHigh)) return { value: n, tone: 'unjudged', fault: 'range' };
  return { value: n, tone: pillTone(n, min, max), fault: null };
}

function HistoryValueCell({ judged, decimals, words }: {
  judged: Judged; decimals: number; words: { failure: string; outOfRange: string };
}) {
  if (judged.fault) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid="history-value" data-tone="fault" className={FAULT_PILL}>
          {judged.fault === 'range' ? words.outOfRange : words.failure}
        </span>
      </td>
    );
  }
  if (judged.value === null) {
    return (
      <td className="px-4 py-3.5 text-center">
        <span data-testid="history-value" data-tone="none" className="text-sm text-slate-400">—</span>
      </td>
    );
  }
  return (
    <td className="px-4 py-3.5 text-center">
      <span data-testid="history-value" data-tone={judged.tone}
        className={`inline-flex rounded-lg px-3 py-1.5 text-sm font-semibold tabular-nums ${PILL_CLASS[judged.tone]}`}>
        {formatDecimals(judged.value, decimals)}
      </span>
    </td>
  );
}

/** ISO → the value a `datetime-local` input needs (local time, no seconds). */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
