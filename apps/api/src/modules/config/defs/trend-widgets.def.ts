import type { ModuleConfigDefinition, SettingDefinition } from '../../../lib/config-registry.js';
import {
  TREND_WIDGET_IDS, TREND_WIDGET_FIELDS, TREND_WIDGET_LABEL_DEFAULT, TREND_WIDGET_FIELD_LABEL,
  TREND_WIDGET_LABEL_MAX, TREND_WIDGET_DATE_FORMATS, TREND_WIDGET_TIME_FORMATS,
  TREND_WIDGET_FORMAT_INHERIT,
  trendWidgetDateFormatKey, trendWidgetTimeFormatKey,
  type TrendWidgetLabelKey,
} from '@digilog/shared';

/**
 * What every widget on the instrument trend page is CALLED, and how each one
 * prints a date and a time.
 *
 * Modelled on `alarm-type-names.def.ts`, which is the closest existing thing: pure
 * display wording, administered in one place, applied everywhere it is shown, and
 * read LIVE so a rename re-labels the page including its history. Nothing a §11
 * record turns on is stored here — the readings, the limits, the precision and
 * the timestamps are untouched by anything on this page.
 *
 * **This is administered configuration, not a user preference.** It is identical
 * for every user and every change is recorded, which is why it lives in
 * `system_config` and not in the browser. The same wording reaches the trend page
 * for an operator who cannot edit it.
 *
 * **The gate is `requiredRole: 'SUPER_ADMIN'`, and there is no re-auth.** That is
 * the settled precedent for display-wording defs — `alarm-type-names`,
 * `rs485-alarms` and `sensor-range-alarms` all carry `requiresReauth: false` and
 * no `reauthAction`, and the dynamic PUT route reads exactly those two fields to
 * decide whether to demand a signature. Adding one here would make renaming a
 * column heading a heavier act than renaming an ALARM TYPE, which is the same
 * kind of wording on a more consequential surface.
 *
 * **What a rename does NOT touch, on the record:** the bracketed unit legends
 * under the alarms table's headings (`(°C / %RH)`, `(H/m)`) and the tooltip that
 * expands `H/m`. They explain the CELLS, not the column's name, and a rename that
 * silently dropped them would leave a column of bare numbers with no units.
 *
 * **Format overrides default to Inherit**, so an untouched installation renders
 * every date and time on the trend page exactly as it did before this def
 * existed. Only the FORMAT is overridable — never the timezone. Two widgets on
 * one screen naming different instants for the same stored reading would be a
 * false statement about the record rather than a display choice.
 */

const dateOptions = [
  { value: TREND_WIDGET_FORMAT_INHERIT, label: 'Inherit — use the site-wide Date/Time Format' },
  ...TREND_WIDGET_DATE_FORMATS.map((v) => ({ value: v, label: v })),
];

const timeOptions = [
  { value: TREND_WIDGET_FORMAT_INHERIT, label: 'Inherit — use the site-wide Date/Time Format' },
  ...TREND_WIDGET_TIME_FORMATS.map((v) => ({ value: v, label: v })),
];

/** What each field is, in the words an admin reading the config page needs. */
const LABEL_DESCRIPTION: Record<TrendWidgetLabelKey, string> = {
  tempCardTitle: 'The heading on the temperature latest-value card.',
  humidCardTitle: 'The heading on the humidity latest-value card.',
  tempChartTitle: 'The heading on the temperature trend chart.',
  humidChartTitle: 'The heading on the humidity trend chart.',
  timeseriesTitle: 'The heading on the raw readings table.',
  timeseriesSubtitle: 'The line under that heading.',
  timeseriesTimestampHeading: 'The first column of the raw readings table.',
  timeseriesTemperatureHeading: 'The temperature column of the raw readings table, units included.',
  timeseriesHumidityHeading: 'The humidity column of the raw readings table, units included.',
  alarmsTitle: 'The heading on the alarms table.',
  alarmsTypeHeading: 'The alarms table column naming which kind of alarm this is.',
  alarmsRaisedHeading: 'The alarms table column holding when the alarm was raised.',
  alarmsGeneratedValueHeading:
    'The alarms table column holding the reading that raised it. The bracketed unit legend under this heading is not renameable — it explains the cells, not the column.',
  alarmsLimitHeading: 'The alarms table column holding the threshold the alarm fired against.',
  alarmsClearedHeading: 'The alarms table column holding when the alarm cleared.',
  alarmsClearedValueHeading:
    'The alarms table column holding the reading that cleared it. The bracketed unit legend under this heading is not renameable.',
  alarmsStatusHeading: 'The alarms table column holding the alarm state.',
  alarmsDurationHeading:
    'The alarms table column holding how long the alarm was open. The (H/m) legend and the tooltip explaining it are not renameable.',
  alarmsAcknowledgedByHeading: 'The alarms table column naming who signed for the alarm.',
};

/**
 * Built from `TREND_WIDGET_FIELDS` rather than typed out.
 *
 * Thirty-one settings written by hand is thirty-one chances for a key here to
 * disagree with the key the widget reads — and the failure would be a silently
 * unadministrable heading, which looks exactly like a working one. The shared
 * module already owns the widget → fields mapping and the dialog renders from the
 * same source, so there is one list, not three.
 */
function buildSettings(): SettingDefinition[] {
  const out: SettingDefinition[] = [];
  for (const id of TREND_WIDGET_IDS) {
    const widget = TREND_WIDGET_FIELDS[id];
    for (const key of widget.labelKeys) {
      out.push({
        key,
        // The field's NAME, not its shipped VALUE — the same split
        // `alarm-type-names.def.ts` makes. Labelling these boxes "Type",
        // "Status" and "Limit" would put six groups of words on the config page
        // that read as values rather than as the fields you type into.
        label: TREND_WIDGET_FIELD_LABEL[key],
        type: 'string',
        description: LABEL_DESCRIPTION[key],
        default: TREND_WIDGET_LABEL_DEFAULT[key],
        maxLength: TREND_WIDGET_LABEL_MAX,
        group: widget.name,
      });
    }
    out.push({
      key: trendWidgetDateFormatKey(id),
      type: 'select',
      label: 'Date format',
      description: 'Inherit prints dates exactly as the site-wide Date/Time Format setting says.',
      default: TREND_WIDGET_FORMAT_INHERIT,
      options: dateOptions,
      group: widget.name,
    });
    out.push({
      key: trendWidgetTimeFormatKey(id),
      type: 'select',
      label: 'Time format',
      description: 'Inherit prints times exactly as the site-wide Date/Time Format setting says.',
      default: TREND_WIDGET_FORMAT_INHERIT,
      options: timeOptions,
      group: widget.name,
    });
  }
  return out;
}

export const trendWidgetsDef: ModuleConfigDefinition = {
  moduleKey: 'trend-widgets',
  moduleName: 'Trend Page Widgets',
  description: 'What each widget on the instrument trend page is called, and how it prints dates and times.',
  icon: 'chart',
  category: 'display',
  sortOrder: 22,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: buildSettings(),
};
