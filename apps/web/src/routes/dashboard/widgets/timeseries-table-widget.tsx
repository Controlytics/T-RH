/**
 * Time series table — the stored readings of the widget's instruments, merged
 * and paged on the SERVER (`telemetry-history`, newest first), a column per key.
 *
 * A measured cell prints at the server's decimals for that instrument and key; a
 * raw cell as received, or at the widget's decimals. The query names at most the
 * first 50 instruments (it is a GET; the id list rides in the URL) and the widget
 * says so when the selection is larger.
 */
import { useEffect, useMemo, useState } from 'react';
import { WIDGET_INSTRUMENTS_MAX, type CustomWidget, type LatestKeyValue } from '@digilog/shared';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { formatKeyValue } from './key-value';
import { widgetPageSize } from './type-switch';
import { useWidgetTimeseries, type WidgetSelection } from './use-widget-data';
import {
  CapNote, LOAD_FAILED, NO_INSTRUMENTS, PeriodSelect, WidgetMessage, useWidgetRange, useWidgetRows, valueOf,
} from './widget-common';

export function TimeseriesTableWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const { preset, setPreset, range } = useWidgetRange(widget.options.period, selection.window);
  const { formatDateTime } = useDatetimeFormat();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(widgetPageSize(widget));

  const keys = widget.keys.filter((k) => k.source === 'telemetry');
  // Only instruments that have SENT one of the keys — the 50 must not be spent on
  // instruments that would add no row (review 2026-10-29).
  const carriers = rows.filter((r) => keys.some((k) => valueOf(r, k)?.ts != null));
  const queried = carriers.slice(0, WIDGET_INSTRUMENTS_MAX);
  const ids = queried.map((r) => r.instrumentId);
  const history = useWidgetTimeseries(ids, keys.map((k) => k.key), range, page, pageSize);
  const byId = useMemo(() => new Map(rows.map((r) => [r.instrumentId, r])), [rows]);

  useEffect(() => { setPage(1); }, [preset, pageSize]);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  /** One stored reading, printed by the same rule as the instrument's latest value. */
  const cellText = (instrumentId: string, key: (typeof keys)[number], value: unknown): string => {
    const row = byId.get(instrumentId);
    const latest = row ? valueOf(row, key) : undefined;
    const v: LatestKeyValue = latest
      ? { ...latest, value: value ?? null }
      : { source: 'telemetry', key: key.key, value: value ?? null, ts: null, unit: null, decimals: null, display: null, judged: null };
    return formatKeyValue(v, key);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <PeriodSelect name={`widget-period-${widget.id}`} value={preset} onChange={setPreset} withDashboard={selection.window !== undefined} />
        <CapNote shown={queried.length} total={carriers.length} noun="instruments" />
      </div>
      {/* The app's table (ruling R5, 2026-10-29) — see latest-table-widget. */}
      <Table data-testid="timeseries-table">
        <TableHeader>
          <tr>
            <TableHead scope="col">Time</TableHead>
            <TableHead scope="col">Instrument ID</TableHead>
            {keys.map((k) => <TableHead key={k.key} scope="col">{k.label ?? k.key}</TableHead>)}
          </tr>
        </TableHeader>
        <TableBody>
          {history.rows.length === 0 ? (
            <tr>
              <td colSpan={2 + keys.length} className="px-4 py-4 text-center text-slate-500">
                {history.loading ? 'Loading…' : 'No readings in this period.'}
              </td>
            </tr>
          ) : history.rows.map((r) => (
            <TableRow key={`${r.instrumentId}:${r.ts}`} data-testid="timeseries-row">
              <TableCell className="whitespace-nowrap">{formatDateTime(r.ts)}</TableCell>
              <TableCell className="whitespace-nowrap font-semibold text-slate-800">{byId.get(r.instrumentId)?.code ?? '—'}</TableCell>
              {keys.map((k) => (
                <TableCell key={k.key} className="tabular-nums">{cellText(r.instrumentId, k, r.values[k.key])}</TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {history.total > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          totalItems={history.total}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}
    </div>
  );
}
