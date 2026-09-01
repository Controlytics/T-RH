/**
 * What every widget on the instrument trend page is CALLED, and how each one
 * prints a date and a time — one administered place for all six.
 *
 * The page's five widgets (the two latest-value cards, the two trend charts, the
 * raw time-series table and the alarms table) carried their titles, their
 * subtitles and every one of their column headings as literals in six different
 * components. A site that calls a thing something else had to be given a patched
 * build. These are the same kind of pure display wording as
 * `alarm-type-names` — administered configuration, identical for every user,
 * recorded on change — and they follow that file's rules exactly.
 *
 * **A blank value falls back to the SHIPPED wording, never to an empty heading.**
 * An admin who clears a field must not be able to leave a table column with no
 * name. `trendWidgetLabel()` is the only reader; nothing in the browser may
 * default a label to a literal of its own.
 *
 * **Read live, not frozen.** A heading is a label, not a measurement: renaming
 * one re-labels the page including its history, which is the point. Nothing a
 * §11 record turns on moves with it — the readings, the limits, the precision
 * and the timestamps are untouched.
 *
 * **Only the FORMAT is overridable, never the TIMEZONE.** A per-widget timezone
 * would let two widgets on one screen name different instants for the same
 * stored reading, which is a false statement about the record rather than a
 * display choice. The zone always comes from `/api/config/datetime/current`.
 */

/** The six widgets, each addressable on its own. */
export type TrendWidgetId =
  | 'tempCard'
  | 'humidCard'
  | 'tempChart'
  | 'humidChart'
  | 'timeseries'
  | 'alarms';

/** Every widget, in the order the trend page renders them. */
export const TREND_WIDGET_IDS: readonly TrendWidgetId[] = [
  'tempCard', 'humidCard', 'tempChart', 'humidChart', 'timeseries', 'alarms',
] as const;

/**
 * Every renameable piece of wording on the page.
 *
 * The two cards and the two charts are each ONE component rendered TWICE, and
 * they get SEPARATE keys on purpose: a single shared "card title" would make
 * renaming the temperature card rename the humidity card beside it.
 */
export type TrendWidgetLabelKey =
  | 'tempCardTitle'
  | 'humidCardTitle'
  | 'tempChartTitle'
  | 'humidChartTitle'
  | 'timeseriesTitle'
  | 'timeseriesSubtitle'
  | 'timeseriesTimestampHeading'
  | 'timeseriesTemperatureHeading'
  | 'timeseriesHumidityHeading'
  | 'alarmsTitle'
  | 'alarmsTypeHeading'
  | 'alarmsRaisedHeading'
  | 'alarmsGeneratedValueHeading'
  | 'alarmsLimitHeading'
  | 'alarmsClearedHeading'
  | 'alarmsClearedValueHeading'
  | 'alarmsStatusHeading'
  | 'alarmsDurationHeading'
  | 'alarmsAcknowledgedByHeading';

/**
 * The shipped wording — exactly what the six components printed as literals
 * before any of this was administered.
 *
 * These strings are the fallback for a blank field, so changing one here changes
 * what an installation that has never touched the config page displays.
 */
export const TREND_WIDGET_LABEL_DEFAULT: Record<TrendWidgetLabelKey, string> = {
  tempCardTitle: 'Temperature',
  humidCardTitle: 'Humidity',
  tempChartTitle: 'Temperature Trend',
  humidChartTitle: 'Humidity Trend',
  timeseriesTitle: 'Time Series (Raw Readings)',
  timeseriesSubtitle: 'Detailed list of raw sensor readings',
  timeseriesTimestampHeading: 'Timestamp',
  timeseriesTemperatureHeading: 'Temperature (°C)',
  timeseriesHumidityHeading: 'Humidity (%RH)',
  alarmsTitle: 'Alarms in this period',
  alarmsTypeHeading: 'Type',
  alarmsRaisedHeading: 'Raised',
  alarmsGeneratedValueHeading: 'Generated Value',
  alarmsLimitHeading: 'Limit',
  alarmsClearedHeading: 'Cleared',
  alarmsClearedValueHeading: 'Cleared Value',
  alarmsStatusHeading: 'Status',
  alarmsDurationHeading: 'Duration',
  alarmsAcknowledgedByHeading: 'Acknowledged by',
};

/**
 * What each field is CALLED on an editing surface — distinct from
 * `TREND_WIDGET_LABEL_DEFAULT`, which is the VALUE it ships with.
 *
 * The two are easy to conflate and the result is a config page whose fields are
 * labelled "Type", "Status" and "Limit" — words that read as values, not as the
 * names of the boxes you type into. `alarm-type-names.def.ts` gets this right
 * ("High temperature limit" as the label, the shipped name as the default), and
 * this map is what lets the def and the per-widget dialog follow it from ONE
 * list rather than two.
 */
export const TREND_WIDGET_FIELD_LABEL: Record<TrendWidgetLabelKey, string> = {
  tempCardTitle: 'Card title',
  humidCardTitle: 'Card title',
  tempChartTitle: 'Chart title',
  humidChartTitle: 'Chart title',
  timeseriesTitle: 'Card title',
  timeseriesSubtitle: 'Subtitle',
  timeseriesTimestampHeading: 'Timestamp column heading',
  timeseriesTemperatureHeading: 'Temperature column heading',
  timeseriesHumidityHeading: 'Humidity column heading',
  alarmsTitle: 'Card title',
  alarmsTypeHeading: 'Alarm type column heading',
  alarmsRaisedHeading: 'Raised-at column heading',
  alarmsGeneratedValueHeading: 'Triggering reading column heading',
  alarmsLimitHeading: 'Threshold column heading',
  alarmsClearedHeading: 'Cleared-at column heading',
  alarmsClearedValueHeading: 'Clearing reading column heading',
  alarmsStatusHeading: 'Alarm state column heading',
  alarmsDurationHeading: 'Open-duration column heading',
  alarmsAcknowledgedByHeading: 'Signed-by column heading',
};

/** Every label key, in the order the config page lists them. */
export const TREND_WIDGET_LABEL_KEYS = Object.keys(
  TREND_WIDGET_LABEL_DEFAULT,
) as TrendWidgetLabelKey[];

/**
 * How long a piece of wording may be. A title sits above a card and a heading
 * sits in a table column; a sentence would wreck both. Longer than
 * `ALARM_TYPE_NAME_MAX` because two of these are a subtitle and a heading that
 * carries its units.
 */
export const TREND_WIDGET_LABEL_MAX = 60;

/**
 * The administered wording, or the shipped one when it is blank, absent or still
 * loading.
 *
 * The SAME rule as `alarmTypeName()` and every other configurable wording in
 * this codebase, and the reason it is a function rather than a lookup: an admin
 * clearing the field must not be able to leave a blank where a column name goes.
 */
export function trendWidgetLabel(
  cfg: TrendWidgetConfig | undefined,
  key: TrendWidgetLabelKey,
): string {
  const v = cfg?.[key];
  return typeof v === 'string' && v.trim() ? v.trim() : TREND_WIDGET_LABEL_DEFAULT[key];
}

// ─────────────────────────── date and time format ───────────────────────────

/**
 * The date formats on offer — LIFTED FROM `datetime.def.ts`, not invented here.
 *
 * A second vocabulary of format strings is how one screen comes to offer a
 * format `useDatetimeFormat` has never heard of and silently renders as
 * DD/MM/YYYY. If a format is added to the site-wide setting, add it here in the
 * same commit; these two lists are the same list.
 */
export const TREND_WIDGET_DATE_FORMATS: readonly string[] = [
  'DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY', 'MMM DD, YYYY',
] as const;

/** The clock, from the same place. */
export const TREND_WIDGET_TIME_FORMATS: readonly string[] = ['12-hour', '24-hour'] as const;

/**
 * "This widget does not override the site-wide setting" — the DEFAULT for every
 * widget, so an untouched page behaves exactly as it did before any of this
 * existed.
 *
 * An explicit word rather than an empty string: the dynamic config page already
 * spends `value=""` on its own "Select …" placeholder, so a blank sentinel would
 * render there as an unlabelled non-choice instead of naming what it does. Blank
 * and absent are still ACCEPTED as inherit by the resolver below — the sentinel
 * is how it is written, not the only thing that is read.
 */
export const TREND_WIDGET_FORMAT_INHERIT = 'inherit';

/** One widget's two format overrides. An empty string means inherit. */
export interface TrendWidgetFormat {
  /** A value from `TREND_WIDGET_DATE_FORMATS`, or `''` to inherit. */
  dateFormat: string;
  /** A value from `TREND_WIDGET_TIME_FORMATS`, or `''` to inherit. */
  timeFormat: string;
}

/** The stored `system_config` key for a widget's date format. */
export function trendWidgetDateFormatKey(id: TrendWidgetId): string {
  return `${id}DateFormat`;
}

/** The stored `system_config` key for a widget's time format. */
export function trendWidgetTimeFormatKey(id: TrendWidgetId): string {
  return `${id}TimeFormat`;
}

/**
 * A stored override, or `''` when this widget inherits.
 *
 * **Anything not in the vocabulary inherits.** That direction is deliberate:
 * `useDatetimeFormat`'s own `formatDateValue` falls through its `switch` to
 * `en-GB` for an unrecognised string, so a stale or mistyped override would print
 * DD/MM/YYYY on a site administered as MM/DD/YYYY — quietly wrong, and wrong in a
 * way that looks like a deliberate setting. Inheriting instead makes the widget
 * agree with every other date on the page.
 */
function overrideOrInherit(value: unknown, vocabulary: readonly string[]): string {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (v === '' || v === TREND_WIDGET_FORMAT_INHERIT) return '';
  return vocabulary.includes(v) ? v : '';
}

/** One widget's format overrides, each resolved to a known value or to inherit. */
export function trendWidgetFormat(
  cfg: TrendWidgetConfig | undefined,
  id: TrendWidgetId,
): TrendWidgetFormat {
  return {
    dateFormat: overrideOrInherit(cfg?.[trendWidgetDateFormatKey(id)], TREND_WIDGET_DATE_FORMATS),
    timeFormat: overrideOrInherit(cfg?.[trendWidgetTimeFormatKey(id)], TREND_WIDGET_TIME_FORMATS),
  };
}

// ─────────────────────────────── the payload ────────────────────────────────

/** The raw `system_config['trend-widgets']` row: a flat bag of strings. */
export type TrendWidgetConfig = Record<string, unknown>;

/**
 * Everything the trend page needs, already defaulted, so no consumer has to know
 * which fields are set.
 *
 * Labels are ALWAYS non-blank. Formats are `''` when the widget inherits, which
 * is what `useDatetimeFormat` treats as "no override".
 */
export interface TrendWidgetTexts {
  labels: Record<TrendWidgetLabelKey, string>;
  formats: Record<TrendWidgetId, TrendWidgetFormat>;
}

/**
 * Resolve a stored row into the payload the page reads.
 *
 * Shared rather than written in the route, because the browser resolves the same
 * thing while the request is still in flight — and a widget that showed one
 * fallback for the first 200 ms and a different one afterwards would be a
 * flicker nobody could explain.
 */
export function resolveTrendWidgetTexts(cfg: TrendWidgetConfig | undefined): TrendWidgetTexts {
  const labels = {} as Record<TrendWidgetLabelKey, string>;
  for (const key of TREND_WIDGET_LABEL_KEYS) labels[key] = trendWidgetLabel(cfg, key);
  const formats = {} as Record<TrendWidgetId, TrendWidgetFormat>;
  for (const id of TREND_WIDGET_IDS) formats[id] = trendWidgetFormat(cfg, id);
  return { labels, formats };
}

// ───────────────────────── which fields belong to whom ──────────────────────

/**
 * Which wording each widget owns — the ONE mapping from a widget to its
 * editable fields.
 *
 * The per-widget edit dialog lists exactly these, so it cannot offer a field
 * that widget does not render, and cannot omit one it does. A second
 * hand-maintained list in the dialog is precisely how a heading ends up
 * unreachable from the only surface that is supposed to administer it.
 */
export const TREND_WIDGET_FIELDS: Record<TrendWidgetId, {
  /** What the widget is called on the config page and in the dialog's title. */
  name: string;
  labelKeys: readonly TrendWidgetLabelKey[];
}> = {
  tempCard: { name: 'Temperature Card', labelKeys: ['tempCardTitle'] },
  humidCard: { name: 'Humidity Card', labelKeys: ['humidCardTitle'] },
  tempChart: { name: 'Temperature Chart', labelKeys: ['tempChartTitle'] },
  humidChart: { name: 'Humidity Chart', labelKeys: ['humidChartTitle'] },
  timeseries: {
    name: 'Time Series Table',
    labelKeys: [
      'timeseriesTitle', 'timeseriesSubtitle', 'timeseriesTimestampHeading',
      'timeseriesTemperatureHeading', 'timeseriesHumidityHeading',
    ],
  },
  alarms: {
    name: 'Alarms Table',
    labelKeys: [
      'alarmsTitle', 'alarmsTypeHeading', 'alarmsRaisedHeading',
      'alarmsGeneratedValueHeading', 'alarmsLimitHeading', 'alarmsClearedHeading',
      'alarmsClearedValueHeading', 'alarmsStatusHeading', 'alarmsDurationHeading',
      'alarmsAcknowledgedByHeading',
    ],
  },
};

/**
 * Harden a payload that ARRIVED over the wire in the resolved shape.
 *
 * The narrow-slice route resolves server-side, as every other administered
 * wording in this codebase does — the browser must not re-derive policy. This is
 * not a second resolver: it is the guard for the case where what came back is not
 * the shape that was asked for at all.
 *
 * That case is not hypothetical. A stale build, a proxy error page, a
 * partially-deployed server — any of them hands the page an object with no
 * `labels` and no `formats`, and `labels.alarmsTitle` on `undefined` throws
 * during render, which white-screens the whole trend page over a COLUMN HEADING.
 * A monitoring screen must not be brought down by its own captions.
 *
 * The rule it applies is the one already stated at the top of this file, taken to
 * its limit: an unusable value falls back to the shipped wording, and an
 * unrecognised format inherits. A missing payload is simply every field unset.
 */
export function coerceTrendWidgetTexts(payload: unknown): TrendWidgetTexts {
  const bag = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const rawLabels = (bag.labels && typeof bag.labels === 'object' ? bag.labels : {}) as TrendWidgetConfig;
  const rawFormats = (bag.formats && typeof bag.formats === 'object' ? bag.formats : {}) as Record<string, unknown>;

  const labels = {} as Record<TrendWidgetLabelKey, string>;
  // The SAME resolver the server used, so a blank that slipped through still
  // becomes the shipped wording rather than an empty heading.
  for (const key of TREND_WIDGET_LABEL_KEYS) labels[key] = trendWidgetLabel(rawLabels, key);

  const formats = {} as Record<TrendWidgetId, TrendWidgetFormat>;
  for (const id of TREND_WIDGET_IDS) {
    const f = (rawFormats[id] && typeof rawFormats[id] === 'object' ? rawFormats[id] : {}) as Record<string, unknown>;
    formats[id] = {
      dateFormat: overrideOrInherit(f.dateFormat, TREND_WIDGET_DATE_FORMATS),
      timeFormat: overrideOrInherit(f.timeFormat, TREND_WIDGET_TIME_FORMATS),
    };
  }
  return { labels, formats };
}
