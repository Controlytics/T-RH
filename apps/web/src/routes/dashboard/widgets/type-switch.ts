/**
 * What the Add widget dialog keeps when the type changes, and what it saves for a
 * type — so a widget can never be saved with a key or an option its type refuses
 * (the strict layout writer would 400 on the leftover). Read from the shared
 * registry, `WIDGET_TYPE_SPECS`; nothing here restates a type's rules.
 *
 * Also the ONE page-size default of a paged widget, read by the dialog's Rows per
 * page AND by the renderer, so the two cannot drift.
 */
import {
  WIDGET_TYPE_SPECS,
  type CustomWidget, type WidgetKey, type WidgetOptionName, type WidgetType,
} from '@digilog/shared';

export type WidgetOptions = CustomWidget['options'];

/**
 * The options the dialog OFFERS, and so saves, for a type. The nine phase 2
 * types offer exactly their spec's options. The phase 1 five keep the phase 1
 * controls word for word, which are NOT their spec lists: the latest values
 * table has Rows per page (its renderer reads it), and the alarm table has no
 * Rows per page (it pages itself at the administered size).
 */
const PHASE1_OFFERED: Partial<Record<WidgetType, readonly WidgetOptionName[]>> = {
  value_cards: [],
  latest_table: ['pageSize'],
  trend_chart: ['period'],
  timeseries_table: ['period', 'pageSize'],
  alarm_table: ['status'],
};

/** Rows per page when a paged widget stores none. */
export const WIDGET_PAGE_SIZE_DEFAULT: Readonly<Partial<Record<WidgetType, number>>> = {
  latest_table: 25,
  timeseries_table: 25,
  instrument_list: 10,
};

/** The rows per page a paged widget shows: its stored choice, else its type's default. */
export function widgetPageSize(widget: Pick<CustomWidget, 'type' | 'options'>): number {
  return widget.options.pageSize ?? WIDGET_PAGE_SIZE_DEFAULT[widget.type] ?? 25;
}

export function offeredOptions(type: WidgetType): readonly WidgetOptionName[] {
  return PHASE1_OFFERED[type] ?? WIDGET_TYPE_SPECS[type].options;
}

/** The options of `options` that `type` is offered; an unset one is left out. */
export function optionsForType(type: WidgetType, options: WidgetOptions): WidgetOptions {
  const offered = offeredOptions(type);
  return Object.fromEntries(
    Object.entries(options).filter(([name, value]) => value !== undefined && offered.includes(name as WidgetOptionName)),
  ) as WidgetOptions;
}

/**
 * The chosen keys `type` takes: none for a type that takes no keys, no attribute
 * for one that shows history, and at most its `keysMax` (the first chosen kept).
 */
export function keysForType(type: WidgetType, keys: readonly WidgetKey[]): WidgetKey[] {
  const spec = WIDGET_TYPE_SPECS[type];
  if (spec.keys === 'none') return [];
  const kept = spec.keys === 'telemetry' ? keys.filter((k) => k.source !== 'attribute') : [...keys];
  return kept.slice(0, spec.keysMax);
}
