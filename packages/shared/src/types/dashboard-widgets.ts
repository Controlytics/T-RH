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
import type { PanelKey } from './panels.js';

/**
 * The panel that decides whether a viewer sees built widgets at all (Roles &
 * Access → Panels). A GATE, never a grid item: the layout never places a card
 * for it, and an item named it is dropped on read.
 */
export const CUSTOM_WIDGETS_PANEL = 'custom_widgets';

/** A grid item that places a widget is `w:<widget id>`. */
export const WIDGET_ITEM_PREFIX = 'w:';

/**
 * APPENDED to, never reordered: the order is the order of the Add widget picker
 * and of the registry below. The first five are the phase 1 types; the last nine
 * are dashboard builder phase 2 (2026-10-30).
 */
export const WIDGET_TYPES = [
  'value_cards', 'latest_table', 'trend_chart', 'timeseries_table', 'alarm_table',
  'gauge', 'bar_chart', 'comparison_bar', 'pie_chart', 'alarm_counts', 'status_grid', 'instrument_list', 'text_card', 'floorplan',
] as const;

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
/** Gauges drawn at most on one gauge widget (it has up to 6 keys x several instruments). */
export const GAUGES_SHOWN_MAX = 24;
/** A bar chart's series: the same palette limit as the trend chart. */
export const BAR_SERIES_MAX = TREND_SERIES_MAX;
/** A text card's text, in characters. */
export const TEXT_CARD_MAX = 2000;
/** Value cards drawn at most; the widget says how many it did not draw. */
export const VALUE_CARDS_SHOWN_MAX = 60;
/** Colours are an INDEX into the chart palette (the web's `SERIES_COLORS`). */
export const WIDGET_COLOR_COUNT = 6;
/**
 * A gauge's and a comparison bar's keys: = the palette (`WIDGET_COLOR_COUNT`), so
 * two same-coloured series never stand side by side with nothing to tell them apart.
 */
export const GAUGE_KEYS_MAX = WIDGET_COLOR_COUNT;
export const COMPARISON_KEYS_MAX = WIDGET_COLOR_COUNT;
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

/** Bar chart vocabulary. */
export const WIDGET_BAR_BUCKETS = ['hour', 'day', 'week'] as const;
export const WIDGET_BAR_AGGS = ['avg', 'min', 'max', 'count'] as const;
export const WIDGET_BAR_GROUPS = ['all', 'instrument'] as const;
/** What a pie chart counts. */
export const WIDGET_PIE_SUBJECTS = ['status', 'alarm_types'] as const;

/** Every option a widget may carry. A type's spec lists the ONLY ones it may use. */
export type WidgetOptionName =
  | 'period' | 'pageSize' | 'status'
  | 'min' | 'max' | 'bucket' | 'agg' | 'groupBy' | 'of' | 'text' | 'planId';

/**
 * What one widget type is. The ONE place a type's rules live: the schema's
 * `superRefine`, the server's layout gate and (later tasks) the Add widget dialog
 * and the renderers all read this, so they cannot disagree.
 */
export interface WidgetTypeSpec {
  /** What keys it takes: `none` = keys must be `[]`; `telemetry` = no attribute keys (an attribute has no history). */
  keys: 'none' | 'any' | 'telemetry';
  /** At most this many keys (<= WIDGET_KEYS_MAX). */
  keysMax: number;
  /** Takes `options.period` / the dashboard window (history). Every other type shows the present. */
  followsWindow: boolean;
  /** The ONLY options it may carry (phase 2 types; see LEGACY_WIDGET_TYPES). */
  options: readonly WidgetOptionName[];
  /**
   * The extra panel a viewer must hold, on the home dashboard `/`, to be shown it
   * (a built widget never widens Panels). A function of the widget when the gate
   * depends on its options; `null` = none.
   */
  panel: PanelKey | ((w: CustomWidget) => PanelKey | null) | null;
}

export const WIDGET_TYPE_SPECS: Record<WidgetType, WidgetTypeSpec> = {
  value_cards: { keys: 'any', keysMax: WIDGET_KEYS_MAX, followsWindow: false, options: [], panel: null },
  latest_table: { keys: 'any', keysMax: WIDGET_KEYS_MAX, followsWindow: false, options: [], panel: null },
  trend_chart: { keys: 'telemetry', keysMax: WIDGET_KEYS_MAX, followsWindow: true, options: ['period'], panel: null },
  timeseries_table: { keys: 'telemetry', keysMax: WIDGET_KEYS_MAX, followsWindow: true, options: ['period', 'pageSize'], panel: null },
  alarm_table: { keys: 'none', keysMax: 0, followsWindow: false, options: ['pageSize', 'status'], panel: 'dashboard_alarms' },
  gauge: { keys: 'any', keysMax: GAUGE_KEYS_MAX, followsWindow: false, options: ['min', 'max'], panel: null },
  bar_chart: { keys: 'telemetry', keysMax: BAR_SERIES_MAX, followsWindow: true, options: ['period', 'bucket', 'agg', 'groupBy'], panel: null },
  comparison_bar: { keys: 'any', keysMax: COMPARISON_KEYS_MAX, followsWindow: false, options: [], panel: null },
  pie_chart: {
    keys: 'none', keysMax: 0, followsWindow: false, options: ['of'],
    panel: (w) => (w.options.of === 'alarm_types' ? 'dashboard_alarms' : null),
  },
  alarm_counts: { keys: 'none', keysMax: 0, followsWindow: false, options: [], panel: 'dashboard_alarms' },
  status_grid: { keys: 'none', keysMax: 0, followsWindow: false, options: [], panel: null },
  instrument_list: { keys: 'none', keysMax: 0, followsWindow: false, options: ['pageSize'], panel: null },
  text_card: { keys: 'none', keysMax: 0, followsWindow: false, options: ['text'], panel: null },
  floorplan: { keys: 'none', keysMax: 0, followsWindow: false, options: ['planId'], panel: 'telemetry_floorplan' },
};

/**
 * The five phase 1 types. Their stored widgets must parse exactly as they did, so
 * the "an option outside the spec is refused" rule does NOT apply to them (the
 * old schema let `value_cards` carry a `period`, and a stored one may). Their
 * own rules below are the phase 1 rules, word for word.
 */
const LEGACY_WIDGET_TYPES: readonly WidgetType[] = WIDGET_TYPES.slice(0, 5);

/** How a type is named in an error message. */
const WIDGET_TYPE_NOUN: Record<WidgetType, string> = {
  value_cards: 'A value cards widget',
  latest_table: 'A latest values table',
  trend_chart: 'A trend chart',
  timeseries_table: 'A time series table',
  alarm_table: 'An alarm table',
  gauge: 'A gauge',
  bar_chart: 'A bar chart',
  comparison_bar: 'A comparison bar',
  pie_chart: 'A pie chart',
  alarm_counts: 'An alarm counts widget',
  status_grid: 'A status grid',
  instrument_list: 'An instrument list',
  text_card: 'A text card',
  floorplan: 'A floor plan',
};

/** How an option is named in an error message. */
const WIDGET_OPTION_LABEL: Record<WidgetOptionName, string> = {
  period: 'period',
  pageSize: 'page size',
  status: 'status filter',
  min: 'scale minimum',
  max: 'scale maximum',
  bucket: 'bucket',
  agg: 'value',
  groupBy: 'grouping',
  of: 'chart subject',
  text: 'text',
  planId: 'floor plan',
};

/** Why an attribute key is refused on a type whose keys must be telemetry. */
const NO_HISTORY_MESSAGE: Partial<Record<WidgetType, string>> = {
  trend_chart: 'Attributes have no history to plot',
  timeseries_table: 'Attributes have no history to list',
  bar_chart: 'Attributes have no history to plot',
};

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
    // Gauge range for a raw key.
    min: z.number().finite('The minimum must be a number').optional(),
    max: z.number().finite('The maximum must be a number').optional(),
    // Bar chart.
    bucket: z.enum(WIDGET_BAR_BUCKETS).optional(),
    agg: z.enum(WIDGET_BAR_AGGS).optional(),
    groupBy: z.enum(WIDGET_BAR_GROUPS).optional(),
    // Pie chart.
    of: z.enum(WIDGET_PIE_SUBJECTS).optional(),
    // Text card.
    text: z.string().trim()
      .min(1, "Write the card's text")
      .max(TEXT_CARD_MAX, `The text must be ${TEXT_CARD_MAX} characters or fewer`)
      .optional(),
    // Floor plan.
    planId: z.string().regex(UUID_RE, 'Not a floor plan id').optional(),
  }).default({}),
}).superRefine((w, ctx) => {
  const spec = WIDGET_TYPE_SPECS[w.type];
  const noun = WIDGET_TYPE_NOUN[w.type];
  const legacy = LEGACY_WIDGET_TYPES.includes(w.type);

  if (w.type === 'alarm_table') {
    if (w.keys.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: 'An alarm table takes no keys' });
    if (w.options.period !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'period'], message: 'An alarm table has no period' });
  } else {
    if (spec.keys === 'none') {
      if (w.keys.length > 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: `${noun} takes no keys` });
    } else {
      if (w.keys.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: 'Choose at least one key' });
      // The array's own cap is WIDGET_KEYS_MAX; a type's smaller cap is checked here.
      if (spec.keysMax < WIDGET_KEYS_MAX && w.keys.length > spec.keysMax) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys'], message: `At most ${spec.keysMax} keys` });
      }
    }
    if (legacy && w.options.status !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'status'], message: 'Only an alarm table has a status filter' });
    }
  }

  if (!legacy) {
    for (const name of Object.keys(w.options) as WidgetOptionName[]) {
      if (w.options[name] !== undefined && !spec.options.includes(name)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', name], message: `${noun} takes no ${WIDGET_OPTION_LABEL[name]}` });
      }
    }
  }

  if (w.type === 'gauge') {
    const { min, max } = w.options;
    if ((min === undefined) !== (max === undefined)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', min === undefined ? 'min' : 'max'], message: 'Set both the minimum and the maximum, or neither' });
    } else if (min !== undefined && max !== undefined && min >= max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'min'], message: 'The minimum must be below the maximum' });
    }
  }
  if (w.type === 'pie_chart' && w.options.of === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'of'], message: 'Choose what the pie shows' });
  }
  if (w.type === 'text_card' && w.options.text === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'text'], message: "Write the card's text" });
  }
  if (w.type === 'floorplan' && w.options.planId === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['options', 'planId'], message: 'Choose a floor plan' });
  }

  const seen = new Set<string>();
  w.keys.forEach((k, n) => {
    const id = `${k.source}:${k.key}`;
    if (seen.has(id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys', n], message: `"${k.key}" is chosen twice` });
    seen.add(id);
    // Spec §4 makes `numeric` a HINT for telemetry keys; only an attribute —
    // which has no history at all — is refused where history is shown.
    if (spec.keys === 'telemetry' && k.source === 'attribute') {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['keys', n], message: NO_HISTORY_MESSAGE[w.type] ?? 'Attributes have no history' });
    }
  });
}).transform((w) => {
  // The phase 1 five carry ONLY what phase 1 parsed: its object stripped every
  // other name, and the same schema backs the forgiving reader, so strip (never
  // refuse) -- no stored widget can be dropped, and the output is what it was.
  if (!LEGACY_WIDGET_TYPES.includes(w.type)) return w;
  const { period, pageSize, status } = w.options;
  const options: typeof w.options = {};
  if (period !== undefined) options.period = period;
  if (pageSize !== undefined) options.pageSize = pageSize;
  if (status !== undefined) options.status = status;
  return { ...w, options };
});
export type CustomWidget = z.infer<typeof customWidgetSchema>;

/**
 * The extra panel a viewer must hold on the home dashboard to be shown this
 * widget, or `null` for none. The server's `resolveLayout` drops a widget whose
 * gate names a panel the viewer lacks.
 */
export function widgetPanelGate(w: CustomWidget): PanelKey | null {
  const panel = WIDGET_TYPE_SPECS[w.type].panel;
  return typeof panel === 'function' ? panel(w) : panel;
}

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
