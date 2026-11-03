/**
 * The FIELD CATALOGUE of a template kind (× instrument profile, for a profile
 * kind) — what a report template of that kind may print (spec §6; page kinds
 * 2026-11-03, docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md
 * §4, §7). Served by `GET /api/report-templates/catalogue`; the editor offers
 * exactly these, and the download marks a template column outside them "not
 * available". Never re-derived in the browser.
 *
 * In this order:
 *   1. **Built-in** — `REPORT_TEMPLATE_FIELDS(kind)` (shared), as declared,
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
 * Which of 2 and 3 a kind takes is ONE shared predicate,
 * `templateKindTakesProfileFields`: `'all'` both (the reportable widget types),
 * `'attributes'` 3 only (the three per-profile page kinds — a page report's
 * rows are its own, never a device key), `'none'` neither (`pie_chart`,
 * `alarm_counts` — a slice or a figure is never one instrument; `text_card`,
 * `floorplan` — no built-ins either, so nothing at all; the two
 * application-wide page kinds, which have no profile). The browser never
 * filters this list again.
 */
import {
  REPORT_TEMPLATE_FIELDS, ATTRIBUTE_LABELS_CONFIG_KEY, templateKindTakesProfileFields,
  coerceProfileMeasurements, coerceProfileDisplayKeys, coerceAttributeLabels, attributeLabel,
  parseInstrumentAttributeKeys,
  type ReportField, type TemplateKind,
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

/**
 * `profile` is null for an application-wide kind (the route refuses a profile
 * id there, and requires one for every other kind — `scopeMismatch`); a kind
 * that takes profile fields with no profile lists its built-ins only.
 */
export async function buildReportCatalogue(
  profile: CatalogueProfile | null,
  kind: TemplateKind,
  isSuperAdmin: boolean,
): Promise<ReportField[]> {
  const builtin: ReportField[] = REPORT_TEMPLATE_FIELDS(kind).map((f) => ({ ...f }));
  const takes = templateKindTakesProfileFields(kind);
  if (takes === 'none' || !profile) return builtin;

  const noTypes: Awaited<ReturnType<typeof loadMeasurementTypes>> = [];
  const [labelsRow, isOffset, types] = await Promise.all([
    prisma.systemConfig.findUnique({ where: { configKey: ATTRIBUTE_LABELS_CONFIG_KEY } }),
    isSuperAdmin ? Promise.resolve(() => false) : offsetKeyTest(),
    takes === 'all' ? loadMeasurementTypes() : Promise.resolve(noTypes),
  ]);
  const labels = coerceAttributeLabels(labelsRow?.configValue);
  const attributes: ReportField[] = parseInstrumentAttributeKeys(profile.attributeKeys)
    .filter((k) => !isOffset(k))
    .map((k) => ({ id: `attr:${k}`, label: attributeLabel(labels, k), group: 'attribute', kind: 'text' }));
  if (takes === 'attributes') return [...builtin, ...attributes];

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

  return [...builtin, ...keys, ...attributes];
}
