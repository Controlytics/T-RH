/**
 * The FIELD CATALOGUE of a widget type × instrument profile — what a report
 * template of that pair may print (spec §6). Served by
 * `GET /api/report-templates/catalogue`; the editor offers exactly these, and
 * the download marks a template column outside them "not available". Never
 * re-derived in the browser.
 *
 * In this order:
 *   1. **Built-in** — `WIDGET_REPORT_FIELDS[widgetType]` (shared), as declared,
 *      `perKey` included.
 *   2. **Keys** (`key:<k>`) — the profile's MEASURED keys, measurement by
 *      measurement in the profile's order, each of its device keys
 *      (`measured: true`, the measurement's unit, labelled by the
 *      measurement's name — "Humidity (rh)" when it has several device keys);
 *      then the profile's trend-page `displayKeys` (`measured: false`, the
 *      key's own label and unit). A display key that folds onto a measured key
 *      is listed once, as the measured one.
 *   3. **Attributes** (`attr:<k>`) — the profile's `attributeKeys`, labelled by
 *      Attribute Display Names. A sensor-offset key is a SUPER_ADMIN's only:
 *      absent for anyone else (the profile routes' rule, `offsetKeyTest`).
 *
 * A widget type with no field catalogue (`text_card`, `floorplan` — they print
 * what they show) lists nothing at all. `pie_chart` and `alarm_counts` list
 * their built-ins only: a slice or a figure is never one instrument, so a key
 * or attribute cell there is always empty. ONE shared predicate decides both,
 * `widgetTypeTakesProfileFields`, and the browser never filters this list again.
 */
import {
  WIDGET_REPORT_FIELDS, ATTRIBUTE_LABELS_CONFIG_KEY, widgetTypeTakesProfileFields,
  coerceProfileMeasurements, coerceProfileDisplayKeys, coerceAttributeLabels, attributeLabel,
  parseInstrumentAttributeKeys,
  type ReportField, type WidgetType,
} from '@digilog/shared';
import { prisma } from '../../lib/prisma.js';
import { loadMeasurementTypes } from '../instruments/profile-measurements.js';
import { offsetKeyTest } from '../instruments/load-offsets.js';

const fold = (k: string) => k.trim().toLowerCase();

export interface CatalogueProfile {
  attributeKeys: string | null;
  measurements: unknown;
  displayKeys: unknown;
}

export async function buildReportCatalogue(
  profile: CatalogueProfile,
  widgetType: WidgetType,
  isSuperAdmin: boolean,
): Promise<ReportField[]> {
  const builtin: ReportField[] = WIDGET_REPORT_FIELDS[widgetType].map((f) => ({ ...f }));
  if (!widgetTypeTakesProfileFields(widgetType)) return builtin;

  const [types, labelsRow, isOffset] = await Promise.all([
    loadMeasurementTypes(),
    prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } }),
    isSuperAdmin ? Promise.resolve(() => false) : offsetKeyTest(),
  ]);
  const labels = coerceAttributeLabels(labelsRow?.configValue);

  const keys: ReportField[] = [];
  const seen = new Set<string>();
  for (const m of coerceProfileMeasurements(profile.measurements)) {
    const type = types.find((t) => t.code === m.code);
    const name = type?.name ?? m.code;
    const unit = type?.unit?.trim();
    const deviceKeys = m.deviceKeys.filter((k) => {
      if (seen.has(fold(k))) return false;
      seen.add(fold(k));
      return true;
    });
    for (const k of deviceKeys) {
      keys.push({
        id: `key:${k}`,
        label: m.deviceKeys.length > 1 ? `${name} (${k})` : name,
        group: 'key',
        kind: 'number',
        ...(unit ? { unit } : {}),
        measured: true,
      });
    }
  }
  for (const d of coerceProfileDisplayKeys(profile.displayKeys)) {
    if (seen.has(fold(d.key))) continue;
    seen.add(fold(d.key));
    const unit = d.unit?.trim();
    keys.push({
      id: `key:${d.key}`,
      label: d.label?.trim() || d.key,
      group: 'key',
      kind: 'number',
      ...(unit ? { unit } : {}),
      measured: false,
    });
  }

  const attributes: ReportField[] = parseInstrumentAttributeKeys(profile.attributeKeys)
    .filter((k) => !isOffset(k))
    .map((k) => ({ id: `attr:${k}`, label: attributeLabel(labels, k), group: 'attribute', kind: 'text' }));

  return [...builtin, ...keys, ...attributes];
}
