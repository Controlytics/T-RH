/**
 * Built dashboard widgets — widget data keys, phase 2 (2026-10-28).
 *
 * Design: docs/superpowers/specs/2026-10-28-widget-data-keys-design.md §6.
 *
 * A widget is a DISPLAY definition: which instruments (the dashboard's own
 * selection, or a fixed list), which keys, how to show them. It grants nothing —
 * every value it shows comes from the instrument routes, which apply the
 * viewer's own scope. It is stored inside the dashboard layout
 * (`DashboardLayout.widgets`) and placed by a grid item `w:<id>`.
 *
 * ONE schema, used by the layout reader (forgiving: a bad widget is dropped),
 * the layout writer (strict: a bad widget is a 400) and the Add widget dialog,
 * so the three cannot disagree about what a widget is.
 */
import { z } from 'zod';
import { dataKeyRefSchema, DATA_KEYS_PER_REQUEST_MAX } from './data-keys.js';
import { PERIOD_PRESETS } from './telemetry-period.js';

/**
 * The panel that decides whether a viewer sees built widgets at all (Roles &
 * Access → Panels). A GATE, never a grid item: the layout never places a card
 * for it, and an item named it is dropped on read.
 */
export const CUSTOM_WIDGETS_PANEL = 'custom_widgets';

/** A grid item that places a widget is `w:<widget id>`. */
export const WIDGET_ITEM_PREFIX = 'w:';

export const WIDGET_TYPES = ['value_cards', 'latest_table', 'trend_chart', 'timeseries_table', 'alarm_table'] as const;

/** The alarm states an alarm table can be filtered to. */
export const WIDGET_ALARM_STATUSES = ['active-unack', 'active-ack', 'cleared-unack', 'cleared-ack'] as const;
export type WidgetType = (typeof WIDGET_TYPES)[number];

export const WIDGETS_PER_LAYOUT_MAX = 20;
/** A fixed instrument list; also how many instruments a time series table queries. */
export const WIDGET_INSTRUMENTS_MAX = 50;
export const WIDGET_KEYS_MAX = DATA_KEYS_PER_REQUEST_MAX;
/**
 * = the palette (`WIDGET_COLOR_COUNT`): a seventh series would repeat a colour,
 * and the trend chart has no legend to tell two same-coloured lines apart
 * (review 2026-10-29; was 10).
 */
export const TREND_SERIES_MAX = 6;
/** Value cards drawn at most; the widget says how many it did not draw. */
export const VALUE_CARDS_SHOWN_MAX = 60;
/** Colours are an INDEX into the chart palette (the web's `SERIES_COLORS`). */
export const WIDGET_COLOR_COUNT = 6;
export const WIDGET_PAGE_SIZES = [10, 25, 50] as const;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_VALUES: readonly string[] = PERIOD_PRESETS.map((p) => p.value);

/**
 * One key on a widget, with its display settings.
 *
 * `unit` and `decimals` apply to a RAW key only: a measured key's unit and
 * precision are the server's (spec §4), and the renderers ignore these for one.
 */
export const widgetKeySchema = dataKeyRefSchema.extend({
  label: z.string().trim().max(60, 'A label must be 60 characters or fewer').optional(),
  unit: z.string().trim().max(16, 'A unit must be 16 characters or fewer').optional(),
  decimals: z.number().int().min(0).max(6, 'Decimals must be between 0 and 6').optional(),
  color: z.number().int().min(0).max(WIDGET_COLOR_COUNT - 1, 'Not a chart colour').optional(),
});
export type WidgetKey = z.infer<typeof widgetKeySchema>;

export const widgetSourceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('selection') }),
  z.object({
    mode: z.literal('instruments'),
    ids: z.array(z.string().regex(UUID_RE, 'Not an instrument id'))
      .min(1, 'Pick at least one instrument')
      .max(WIDGET_INSTRUMENTS_MAX, `At most ${WIDGET_INSTRUMENTS_MAX} instruments`)
      .transform((ids) => [...new Set(ids)]),
  }),
]);
export type WidgetSource = z.infer<typeof widgetSourceSchema>;

export const customWidgetSchema = z.object({
  id: z.string().regex(UUID_RE, 'Not a widget id'),
  type: z.enum(WIDGET_TYPES),
  title: z.string().trim().min(1, 'A widget needs a title').max(80, 'A title must be 80 characters or fewer'),
  source: widgetSourceSchema,
  keys: z.array(widgetKeySchema)
    .max(WIDGET_KEYS_MAX, `At most ${WIDGET_KEYS_MAX} keys`),
  options: z.object({
    period: z.string().refine((v) => PERIOD_VALUES.includes(v), 'Not a period this widget can show').optional(),
    pageSize: z.union([z.literal(10), z.literal(25), z.literal(50)]).optional(),
    status: z.enum(WIDGET_ALARM_STATUSES).optional(),
  }).default({}),
}).superRefine((w, ctx) => {
  if (w.type === 'alarm_table') {
    if (w.keys.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: 'An alarm table takes no keys' });
    if (w.options.period !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'period'], message: 'An alarm table has no period' });
  } else {
    if (w.keys.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: 'Choose at least one key' });
    if (w.options.status !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'status'], message: 'Only an alarm table has a status filter' });
  }
  const seen = new Set<string>();
  w.keys.forEach((k, n) => {
    const id = `${k.source}:${k.key}`;
    if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys', n], message: `"${k.key}" is chosen twice` });
    seen.add(id);
    // Spec §4 makes `numeric` a HINT for telemetry keys; only an attribute —
    // which has no history at all — is refused for a chart.
    if (w.type === 'trend_chart' && k.source === 'attribute') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys', n], message: 'Attributes have no history to plot' });
    }
    // The same for the time series table: its column would always be empty.
    if (w.type === 'timeseries_table' && k.source === 'attribute') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys', n], message: 'Attributes have no history to list' });
    }
  });
});
export type CustomWidget = z.infer<typeof customWidgetSchema>;

export function widgetItemId(id: string): string {
  return `${WIDGET_ITEM_PREFIX}${id}`;
}

/** The widget id a grid item places, or null when it is not a widget item. */
export function widgetIdOf(i: string): string | null {
  if (!i.startsWith(WIDGET_ITEM_PREFIX)) return null;
  const id = i.slice(WIDGET_ITEM_PREFIX.length);
  return UUID_RE.test(id) ? id : null;
}

export function isWidgetItem(i: string): boolean {
  return widgetIdOf(i) !== null;
}

/**
 * Canonical form for comparison: zod's output carries keys in the SCHEMA's
 * order, whatever order the JSON arrived in, so two equal widgets serialise
 * identically. An unparseable entry stays as it was — it cannot equal a valid one.
 */
function canonical(list: readonly unknown[] | undefined): string {
  return JSON.stringify((list ?? []).map((w) => {
    const r = customWidgetSchema.safeParse(w);
    return r.success ? r.data : w;
  }));
}

/** Whether two widget lists are the same widgets. `undefined` is no widgets. */
export function widgetsEqual(a?: readonly unknown[], b?: readonly unknown[]): boolean {
  return canonical(a) === canonical(b);
}
