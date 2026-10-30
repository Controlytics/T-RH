/**
 * Value cards — one card per instrument × key: the value, the instant, the
 * instrument and its Location. A measured key wears the server's verdict; a raw
 * key wears the neutral grey rule and the words "Not judged", never green.
 */
import { VALUE_CARDS_SHOWN_MAX, type CustomWidget } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useSensorWords } from '@/hooks/use-failure-text';
import { FAULT_INK } from '../status';
import { keyCell } from './key-value';
import type { WidgetSelection } from './use-widget-data';
import { CapNote, LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, useWidgetRows, valueOf } from './widget-common';

export function ValueCardsWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const { formatDateTime } = useDatetimeFormat();
  const words = useSensorWords();

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;

  const cards = rows.flatMap((row) => widget.keys.map((key) => ({ row, key })));
  const shown = cards.slice(0, VALUE_CARDS_SHOWN_MAX);

  return (
    <div className="space-y-2">
      <CapNote shown={shown.length} total={cards.length} noun="cards" />
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(12.5rem,1fr))]">
        {shown.map(({ row, key }) => {
          const v = valueOf(row, key);
          const cell = keyCell(v, row.reporting, key, words);
          return (
            <div
              key={`${row.instrumentId}:${key.source}:${key.key}`}
              data-testid="value-card"
              data-judged={cell.judged ? 'true' : 'false'}
              className={`relative overflow-hidden rounded-[var(--radius-card)] border ${cell.classes.border} bg-white py-3 pl-4 pr-3 shadow-[var(--elev-1)]`}
            >
              {/* The rule down the left edge carries the verdict — or, for a raw
                  key, the neutral grey that says nothing is judging it. */}
              <span aria-hidden className={`absolute inset-y-0 left-0 w-1.5 ${cell.classes.dot}`} />
              <p className="truncate text-xs font-semibold uppercase tracking-wide text-slate-500" title={key.label ?? key.key}>
                {key.label ?? key.key}
              </p>
              <p className="mt-1 flex items-baseline gap-1">
                {/* A fault WORD takes the one fault ink (as on the trend card and the gauge); a number stays slate. */}
                <span className={`text-2xl font-bold tabular-nums ${cell.fault ? FAULT_INK : 'text-slate-900'}`} data-testid="value-card-value">{cell.text}</span>
                {cell.unit && <span className="text-sm font-semibold text-slate-500">{cell.unit}</span>}
              </p>
              <p className={`mt-1 inline-flex items-center gap-1.5 text-xs font-bold ${cell.classes.text}`} data-testid="value-card-status">
                <span aria-hidden className={`h-2 w-2 rounded-full ${cell.classes.dot}`} />
                {cell.label}
              </p>
              <p className="mt-2 truncate text-xs font-semibold text-slate-700" title={row.code}>{row.code}</p>
              <p className="truncate text-xs text-slate-500" title={row.locationAttribute ?? undefined}>
                {row.locationAttribute ?? row.functionalLocationName ?? '—'}
              </p>
              <p className="mt-1 text-[0.6875rem] text-slate-400">{v?.ts ? formatDateTime(v.ts) : '—'}</p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
