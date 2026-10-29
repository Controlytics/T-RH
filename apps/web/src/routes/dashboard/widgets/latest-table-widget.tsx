/**
 * Latest values table — a row per instrument (ID, Area, Location), a column per
 * key. The rows are the server's whole answer for the widget's instruments, so
 * the on-screen paging counts the true total; the search covers every visible
 * column (a column the reader can see and cannot search reads as a broken box).
 */
import { useEffect, useMemo, useState } from 'react';
import type { CustomWidget } from '@digilog/shared';
import { Pagination } from '@/components/ui/pagination';
import { useSensorWords } from '@/hooks/use-failure-text';
import { keyCell } from './key-value';
import type { WidgetSelection } from './use-widget-data';
import { LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, useWidgetRows, valueOf } from './widget-common';

export function LatestTableWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const words = useSensorWords();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(widget.options.pageSize ?? 25);

  const table = useMemo(() => rows.map((row) => ({
    row,
    cells: widget.keys.map((key) => keyCell(valueOf(row, key), row.reporting, key, words)),
  })), [rows, widget.keys, words]);

  const needle = search.trim().toLowerCase();
  const filtered = needle
    ? table.filter(({ row, cells }) => [
      row.code, row.functionalLocationName ?? '', row.locationAttribute ?? '',
      ...cells.map((c) => `${c.text} ${c.unit ?? ''} ${c.label}`),
    ].some((t) => t.toLowerCase().includes(needle)))
    : table;

  // Page 3 of the previous search is usually past the end of the next one.
  useEffect(() => { setPage(1); }, [needle, pageSize]);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  const pageRows = filtered.slice((page - 1) * pageSize, page * pageSize);

  return (
    <div className="space-y-2">
      <input
        type="search"
        name={`widget-search-${widget.id}`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search instrument, area, location or value"
        aria-label="Search this widget"
        className="ctl ctl-sm w-full max-w-sm"
      />
      <div className="overflow-x-auto">
        <table className="tbl tbl-grid w-full text-sm" data-testid="latest-table">
          <thead>
            <tr>
              <th scope="col" className="text-left">Instrument ID</th>
              <th scope="col" className="text-left">Area</th>
              <th scope="col" className="text-left">Location</th>
              {widget.keys.map((k) => (
                <th key={`${k.source}:${k.key}`} scope="col" className="text-left">{k.label ?? k.key}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr><td colSpan={3 + widget.keys.length} className="py-4 text-center text-slate-500">No rows match the search.</td></tr>
            ) : pageRows.map(({ row, cells }) => (
              <tr key={row.instrumentId} data-testid="latest-table-row">
                <td className="font-semibold text-slate-800">{row.code}</td>
                <td>{row.functionalLocationName ?? '—'}</td>
                <td>{row.locationAttribute ?? '—'}</td>
                {cells.map((c, n) => (
                  <td key={n} data-judged={c.judged ? 'true' : 'false'}>
                    <span className="font-bold tabular-nums text-slate-900">{c.text}</span>
                    {c.unit && <span className="ml-1 text-xs text-slate-500">{c.unit}</span>}
                    <span className={`ml-2 inline-flex rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-semibold ${c.classes.bg} ${c.classes.text} ${c.classes.border}`}>
                      {c.label}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {filtered.length > 0 && (
        <Pagination
          page={page}
          pageSize={pageSize}
          totalItems={filtered.length}
          onPageChange={setPage}
          onPageSizeChange={setPageSize}
        />
      )}
    </div>
  );
}
