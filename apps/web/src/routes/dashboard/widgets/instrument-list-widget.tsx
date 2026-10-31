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
 * on a plain click, the ID as a real link for the keyboard and for a new tab —
 * and neither without the host's trail (R7-9). The rows are only ever the
 * current request's (`useWidgetOverview`, I-1).
 *
 * Compact cells (`CELL`) and no minimum widths, so a half-width card (w=6,
 * ~560 px of table) shows every column: Area and Location wrap and clamp to two
 * lines with the whole text on hover, Last seen stacks its date over its time
 * when it must. Below that the shared table's sideways scroll is the safety net.
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

/** The list's cell padding: tighter than the shared table's `px-4` (fix round 1, M-1). */
const CELL = 'px-2.5';
const BODY_CELL = `${CELL} py-2.5`;

/**
 * The server's text, with every hyphenated word kept whole: a narrow column
 * wraps "Module-F staging area" between words, never as "Module- / F".
 * Presentation only — the text is exactly the server's.
 */
function KeepHyphens({ text }: { text: string }) {
  return <>{text.split(/(\S*-\S*)/).map((part, n) => (part.includes('-') ? <span key={n} className="whitespace-nowrap">{part}</span> : part))}</>;
}

/**
 * Whether a click on a row is a plain one, to be followed in this tab: not a
 * Ctrl / ⌘ / Shift / Alt click or another button (the ID link serves those —
 * a new tab, a new window), and not the release of a drag that selected text
 * (M-9).
 */
function plainClick(e: React.MouseEvent): boolean {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return false;
  return !(window.getSelection()?.toString() ?? '');
}

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
            <TableHead scope="col" className={CELL}>Instrument ID</TableHead>
            <TableHead scope="col" className={CELL}>Area</TableHead>
            <TableHead scope="col" className={CELL}>Location</TableHead>
            <TableHead scope="col" className={CELL}>Status</TableHead>
            <TableHead scope="col" className={CELL}>Last seen</TableHead>
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
                onOpen={link ? (e) => { if (plainClick(e)) navigate(link.to, { state: link.state }); } : undefined}
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
  onOpen?: (e: React.MouseEvent) => void;
  /** [date, time], or null when the instrument never reported. */
  lastSeen: [string, string] | null;
}) {
  const look = instrumentLook(row);
  const c = look.classes;
  return (
    <TableRow data-testid="instrument-list-row" onClick={onOpen} className={link ? 'cursor-pointer' : undefined}>
      <TableCell className={`${BODY_CELL} whitespace-nowrap font-semibold text-slate-800`}>
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
      <TableCell className={BODY_CELL}>
        <span className="line-clamp-2" title={row.functionalLocationName ?? undefined}><KeepHyphens text={row.functionalLocationName ?? '—'} /></span>
      </TableCell>
      <TableCell className={BODY_CELL}>
        <span className="line-clamp-2" title={row.locationAttribute ?? undefined}><KeepHyphens text={row.locationAttribute ?? '—'} /></span>
      </TableCell>
      <TableCell className={`${BODY_CELL} whitespace-nowrap`}>
        <span
          data-testid="instrument-list-status"
          data-look={look.key}
          className={`inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[0.6875rem] font-semibold ${c.bg} ${c.text} ${c.border}`}
        >
          <span aria-hidden="true" className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} />
          {c.label}
        </span>
      </TableCell>
      <TableCell className={`${BODY_CELL} tabular-nums`}>
        {lastSeen
          ? <><span className="whitespace-nowrap">{lastSeen[0]}</span> <span className="whitespace-nowrap">{lastSeen[1]}</span></>
          : '—'}
      </TableCell>
    </TableRow>
  );
}
