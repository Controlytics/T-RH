/**
 * Instrument list — a row per instrument, in the server's order: its ID, Area
 * (`functionalLocationName`), Location (the `Location` ATTRIBUTE,
 * `locationAttribute` — never `Instrument.location`), Status (`instrumentLook`,
 * the ONE mapping the status widgets share) and when it last reported. Every
 * value is the server's; nothing is re-derived. Present state only.
 *
 * Paged on screen by the widget's page size (`widgetPageSize`, ten unless
 * stored) with the shared pager; the count is the server's whole answer. A row
 * opens its trend page as a status tile does (`trendLinkFor`): the whole row
 * on a click, the ID as a real link for the keyboard — and neither without the
 * host's trail (R7-9). The rows are only ever the current request's
 * (`useWidgetOverview`, I-1).
 */
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CustomWidget } from '@digilog/shared';
import { Pagination } from '@/components/ui/pagination';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import type { OverviewRow } from '../use-telemetry';
import { instrumentLook } from './instrument-look';
import { trendLinkFor, type TrendLink, type WidgetTrail } from './trend-link';
import { widgetPageSize } from './type-switch';
import { useWidgetOverview, type WidgetSelection } from './use-widget-data';
import { LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, WidgetNotes, answerState } from './widget-common';

export function InstrumentListWidget({ widget, selection, trail }: {
  widget: CustomWidget;
  selection: WidgetSelection;
  trail?: WidgetTrail;
}) {
  const { rows, loading, error } = useWidgetOverview(widget.source, selection);
  const answer = answerState(rows.length > 0, error);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(widgetPageSize(widget));
  const navigate = useNavigate();
  const { formatDate, formatTime } = useDatetimeFormat();

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (rows.length === 0) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  // A page past the end — the selection shrank under it — shows the last page.
  const current = Math.min(page, Math.max(1, Math.ceil(rows.length / pageSize)));
  const pageRows = rows.slice((current - 1) * pageSize, current * pageSize);

  return (
    <div className="space-y-2">
      <WidgetNotes refreshFailed={answer === 'stale'} />
      <Table data-testid="instrument-list" aria-label={`${widget.title}: instruments`}>
        <TableHeader>
          <tr>
            <TableHead scope="col">Instrument ID</TableHead>
            <TableHead scope="col">Area</TableHead>
            <TableHead scope="col">Location</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Last seen</TableHead>
          </tr>
        </TableHeader>
        <TableBody>
          {pageRows.map((row) => {
            const link = trendLinkFor(row.instrumentId, trail);
            return (
              <ListRow
                key={row.instrumentId}
                row={row}
                link={link}
                onOpen={link ? () => navigate(link.to, { state: link.state }) : undefined}
                // The administered date, then time (`formatDateTime` is exactly the
                // two joined by a space); kept as two pieces so a narrow card
                // breaks the cell between them, never inside a date.
                lastSeen={row.lastSeenAt ? [formatDate(row.lastSeenAt), formatTime(row.lastSeenAt)] : null}
              />
            );
          })}
        </TableBody>
      </Table>
      <Pagination
        page={current}
        pageSize={pageSize}
        totalItems={rows.length}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
      />
    </div>
  );
}

function ListRow({ row, link, onOpen, lastSeen }: {
  row: OverviewRow;
  link: TrendLink | null;
  onOpen?: () => void;
  /** [date, time], or null when the instrument never reported. */
  lastSeen: [string, string] | null;
}) {
  const look = instrumentLook(row);
  const c = look.classes;
  return (
    <TableRow data-testid="instrument-list-row" onClick={onOpen} className={link ? 'cursor-pointer' : undefined}>
      <TableCell className="whitespace-nowrap font-semibold text-slate-800">
        {link ? (
          <Link
            to={link.to}
            state={link.state}
            // The row's own click would navigate a second time.
            onClick={(e) => e.stopPropagation()}
            aria-label={`Open trend page for ${row.code}`}
            className="underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]"
          >
            {row.code}
          </Link>
        ) : row.code}
      </TableCell>
      {/* Two lines at most, the whole text on hover — the readings table's
          rule for the same two columns, so a long Location in a narrow card
          does not make every row five lines tall. */}
      <TableCell>
        <span className="line-clamp-2 min-w-[6rem]" title={row.functionalLocationName ?? undefined}>{row.functionalLocationName ?? '—'}</span>
      </TableCell>
      <TableCell>
        <span className="line-clamp-2 min-w-[10rem]" title={row.locationAttribute ?? undefined}>{row.locationAttribute ?? '—'}</span>
      </TableCell>
      <TableCell className="whitespace-nowrap">
        <span
          data-testid="instrument-list-status"
          data-look={look.key}
          className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-semibold ${c.bg} ${c.text} ${c.border}`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
          {c.label}
        </span>
      </TableCell>
      <TableCell className="tabular-nums">
        {lastSeen
          ? <><span className="whitespace-nowrap">{lastSeen[0]}</span> <span className="whitespace-nowrap">{lastSeen[1]}</span></>
          : '—'}
      </TableCell>
    </TableRow>
  );
}
