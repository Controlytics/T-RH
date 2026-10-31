/**
 * Status grid — one tile per instrument, in the server's order: its code and
 * the word and colour `instrumentLook` gives it (the ONE mapping from the
 * server's `status` / `reporting` / `judged`; nothing is judged here). Present
 * state only: no period, no window. The tiles auto-fill the panel's width, at
 * most `STATUS_GRID_MAX`, and the widget says how many more it did not draw.
 *
 * A tile opens the instrument's trend page by `trendLinkFor` — the dashboard's
 * origin and breadcrumb trail, and NO link without a trail (the Add widget
 * preview, a dashboard being edited, R7-9). The rows are only ever the current
 * request's (`useWidgetOverview`, fix round 1, I-1).
 */
import { Link } from 'react-router-dom';
import type { CustomWidget } from '@digilog/shared';
import type { OverviewRow } from '../use-telemetry';
import { instrumentLook } from './instrument-look';
import { trendLinkFor, type WidgetTrail } from './trend-link';
import { useWidgetOverview, type WidgetSelection } from './use-widget-data';
import { LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, WidgetNotes, answerState } from './widget-common';

/** Tiles drawn at most; the rest are counted ("N more not shown"), never dropped silently. */
export const STATUS_GRID_MAX = 120;

export function StatusGridWidget({ widget, selection, trail }: {
  widget: CustomWidget;
  selection: WidgetSelection;
  trail?: WidgetTrail;
}) {
  const { rows, loading, error } = useWidgetOverview(widget.source, selection);
  const answer = answerState(rows.length > 0, error);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (rows.length === 0) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  const shown = rows.slice(0, STATUS_GRID_MAX);
  return (
    <div className="space-y-2">
      <WidgetNotes more={rows.length - shown.length} refreshFailed={answer === 'stale'} />
      {/* A LITERAL class (Tailwind cannot see an interpolated one): tiles of at
          least 8.5rem — the longest code, CWH/RDU/101-01, in full — filling the
          panel's width, however wide it is dragged. */}
      <ul data-testid="status-grid" aria-label={`${widget.title}: instrument status`} className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(8.5rem,1fr))]">
        {shown.map((row) => <li key={row.instrumentId} className="min-w-0"><StatusTile row={row} trail={trail} /></li>)}
      </ul>
    </div>
  );
}

function StatusTile({ row, trail }: { row: OverviewRow; trail?: WidgetTrail }) {
  const look = instrumentLook(row);
  const c = look.classes;
  const face = (
    <>
      {/* The status colour as a rail down the tile's edge; the word beside it says the same. */}
      <span aria-hidden="true" data-testid="status-tile-dot" className={`absolute inset-y-0 left-0 w-1 ${c.dot}`} />
      <span data-testid="status-tile-code" title={row.code} className="block truncate text-xs font-bold leading-5 text-slate-800">
        {row.code}
      </span>
      <span data-testid="status-tile-word" className={`block truncate text-[0.6875rem] font-semibold leading-4 ${c.text}`}>
        {c.label}
      </span>
    </>
  );
  const tile = `relative block min-w-0 overflow-hidden rounded-md border py-1.5 pl-3 pr-2 ${c.bg} ${c.border}`;
  const link = trendLinkFor(row.instrumentId, trail);
  if (!link) {
    return <div data-testid="status-tile" data-look={look.key} className={tile}>{face}</div>;
  }
  return (
    <Link
      to={link.to}
      // Where the reader came from, and the dashboard view they left, so the
      // trend page's crumbs lead back to it.
      state={link.state}
      aria-label={`Open trend page for ${row.code} — ${c.label}`}
      data-testid="status-tile"
      data-look={look.key}
      className={`${tile} transition-shadow hover:shadow-[var(--elev-2)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--theme-primary,#2a78d6)]`}
    >
      {face}
    </Link>
  );
}
