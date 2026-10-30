/**
 * Alarm counts — two figures and the types behind them, every number the
 * SERVER's (`GET /api/alarms/counts`, asked with `widgetAlarmScope`, the scope
 * the alarm table asks with):
 * - "Active" = the server's active quadrants (unacknowledged + acknowledged);
 * - "Unacknowledged" = the server's unacknowledged quadrants (active + cleared) —
 *   a cleared alarm nobody answered for is still outstanding;
 * - then every type the server lists, with its active count, named as
 *   administered (the Alarms page's names); a zero is muted, never hidden, and a
 *   type nothing names prints the server's own token.
 * Nothing is counted here (R7-5). A viewer without ALARM_READ gets the 403, and
 * the card says "Could not load this widget." while the rest of the dashboard
 * draws (Review Focus 4). The counts are only ever the current request's
 * (`THIS_REQUEST_ONLY`): a drill-down never shows another location's (I-1).
 * Present state only: no period, no window.
 *
 * Laid out by the CARD's width (container queries), not the window's:
 * - narrow (a quarter card): the two figures as two compact rows, label and
 *   number side by side, then the list in one column;
 * - from 20rem: the figures side by side as tiles;
 * - from 32rem: the list in TWO columns, filled down the first before the second —
 *   a list, not a row-major table (fix round 1, M-8);
 * - from 48rem (a full-width card, the default placement): the figures stand in a
 *   column beside the list.
 */
import type { CustomWidget } from '@digilog/shared';
import { useAlarmTypeNames } from '@/hooks/use-failure-text';
import { alarmScopeSelectsNothing, widgetAlarmScope } from '../alarm-scope';
import { alarmTypeLabel } from './pie-model';
import { useAlarmCounts, type WidgetSelection } from './use-widget-data';
import { LOAD_FAILED, NO_INSTRUMENTS, WidgetMessage, WidgetNotes, answerState, groupDigits } from './widget-common';

/**
 * A figure's colour: the Alarms page's quadrant tones (`--status-*`) while there
 * is something to answer for, the "ok" tone at zero — the dashboard's Active
 * Alarms card's rule. The word beside it always says what it counts.
 */
const TONE = {
  danger: { rail: 'bg-[var(--status-danger-dot)]', ground: 'bg-[var(--status-danger-bg)]', ink: 'text-[var(--status-danger-ink)]' },
  warn: { rail: 'bg-[var(--status-warn-dot)]', ground: 'bg-[var(--status-warn-bg)]', ink: 'text-[var(--status-warn-ink)]' },
  ok: { rail: 'bg-[var(--status-ok-dot)]', ground: 'bg-[var(--status-ok-bg)]', ink: 'text-[var(--status-ok-ink)]' },
} as const;

export function AlarmCountsWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const scope = widgetAlarmScope(widget.source, selection);
  const { data, error } = useAlarmCounts(scope);
  const names = useAlarmTypeNames();
  const answer = answerState(data !== undefined, error);

  if (alarmScopeSelectsNothing(scope)) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (answer === 'failed') return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (!data) return <WidgetMessage>Loading…</WidgetMessage>;

  const q = data.quadrants;
  const active = q.activeUnack + q.activeAck;
  const unacknowledged = q.activeUnack + q.clearedUnack;

  return (
    <div className="@container space-y-2.5">
      <WidgetNotes refreshFailed={answer === 'stale'} refreshNoun="alarms" />
      <div className="space-y-2.5 @3xl:grid @3xl:grid-cols-[15rem_minmax(0,1fr)] @3xl:items-start @3xl:gap-6 @3xl:space-y-0">
        <div className="grid gap-2 @xs:grid-cols-2 @xs:gap-3 @3xl:grid-cols-1">
          <Figure name="active" label="Active" value={active} tone={active > 0 ? 'danger' : 'ok'} />
          <Figure name="unacknowledged" label="Unacknowledged" value={unacknowledged} tone={unacknowledged > 0 ? 'warn' : 'ok'} />
        </div>
        <section>
          <h4 className="text-[0.6875rem] font-semibold uppercase tracking-[0.08em] text-slate-500">Active by type</h4>
          {/* A LIST: down the first column, then the second (CSS columns, never a
              row-major grid); a long administered name wraps, never cut, and a
              row is never split across the two columns. */}
          <ul aria-label="Active alarms by type" className="mt-1 columns-1 gap-x-8 @lg:columns-2">
            {data.byType.map((t) => {
              const zero = t.active === 0;
              return (
                <li
                  key={t.type}
                  data-testid="alarm-type-row"
                  data-zero={zero}
                  className="flex break-inside-avoid items-baseline justify-between gap-3 border-b border-slate-100 py-1 text-xs leading-snug @lg:text-[0.8125rem]"
                >
                  <span data-testid="alarm-type-name" className={`min-w-0 break-words ${zero ? 'text-slate-400' : 'font-medium text-slate-700'}`}>
                    {alarmTypeLabel(t.type, names)}
                  </span>
                  <span data-testid="alarm-type-count" className={`shrink-0 tabular-nums ${zero ? 'text-slate-400' : 'font-bold text-slate-900'}`}>
                    {groupDigits(t.active)}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      </div>
    </div>
  );
}

/**
 * One figure: a compact row (label, then the number at the end) in a narrow
 * card; from 20rem a tile, the label over the number.
 */
function Figure({ name, label, value, tone }: { name: string; label: string; value: number; tone: keyof typeof TONE }) {
  const t = TONE[tone];
  return (
    <div
      data-testid={`alarm-figure-${name}`}
      data-tone={tone}
      className={`relative flex items-center justify-between gap-3 overflow-hidden rounded-[var(--radius-card)] border border-slate-200/70 px-3 pb-1.5 pt-2 @xs:block @xs:px-4 @xs:pb-2.5 @xs:pt-3 ${t.ground}`}
    >
      <span aria-hidden="true" className={`absolute inset-x-0 top-0 h-[3px] ${t.rail}`} />
      <p data-testid="alarm-figure-label" className="min-w-0 break-words text-[0.6875rem] font-semibold uppercase leading-tight tracking-[0.08em] text-slate-600">{label}</p>
      <p data-testid="alarm-figure-value" className={`shrink-0 text-xl font-bold leading-tight tabular-nums @xs:mt-0.5 @xs:text-[length:var(--text-figure)] ${t.ink}`}>
        {groupDigits(value)}
      </p>
    </div>
  );
}
