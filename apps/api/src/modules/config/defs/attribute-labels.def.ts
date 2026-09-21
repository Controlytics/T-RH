import { z } from 'zod';
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { ATTRIBUTE_LABELS_CONFIG_KEY, ATTRIBUTE_LABEL_MAX, ATTRIBUTE_LABEL_KEY_MAX } from '@digilog/shared';

/**
 * Display names for instrument attribute KEYS (2026-09-16).
 *
 * The key is the stored identity — what a device writes over MQTT, what the CSV
 * importer reads, what an audit row names. This def administers only the word a
 * PERSON reads beside the value: on the New Instrument form, the Attributes
 * panel, the Settings widget and the Attribute Access picker. A rename here
 * changes none of the records those screens show; `Enable_Temp_NMT` stays
 * `Enable_Temp_NMT` in every row and every payload.
 *
 * ONE global map, by the operator's choice over a per-profile list: a key means
 * the same thing wherever it appears, and a key typed freely on an instrument —
 * one no profile lists — still gets its name.
 *
 * `coerceAttributeLabels()` in `@digilog/shared` is the ONE reader of the stored
 * row; the narrow-slice route (`static-routes/attribute-labels.routes.ts`)
 * serves the coerced map to every authenticated user, the same pattern as
 * `/alarm-type-names/current`. The def itself stays SUPER_ADMIN-only.
 *
 * Edited on Configuration → Instrument Attributes — a Display name box beside
 * each key — not on a page of its own (operator, 2026-09-16: "dont give as
 * seperate configuration add in instrument attributes configuration"; a
 * separate page existed for a few hours). `hasCustomPage` stays FALSE on
 * purpose — `true` would skip the generic `/dynamic/attribute-labels` GET/PUT,
 * which is the endpoint that validates against `zodSchema`, enforces
 * `requiredRole` and writes the `CONFIG_CHANGED` audit row. `customPagePath`
 * points at the Instrument Attributes page so the Configuration index never
 * offers a second door, and that page's card is hardcoded, so the
 * auto-discovered section lists this key by name in its exclusion set.
 */
export const attributeLabelsDef: ModuleConfigDefinition = {
  moduleKey: ATTRIBUTE_LABELS_CONFIG_KEY,
  moduleName: 'Attribute Display Names',
  description: 'What each instrument attribute key is called on screen. The stored key never changes.',
  icon: 'tag',
  category: 'display',
  sortOrder: 15,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  customPagePath: '/config/instrument-attributes',
  settings: [
    {
      key: 'labels',
      type: 'json',
      label: 'Display names',
      description: 'A map of attribute key to the name shown for it. A blank name shows the key itself.',
      default: {},
      group: 'Attribute Display Names',
    },
    {
      // Which fields the SETTINGS page does NOT show (2026-09-21). The HIDDEN
      // set, so a key nobody has considered shows by default. Edited as a
      // "Show in Settings" toggle per row on the same Instrument Attributes
      // page, plus one for the Instrument ID tile. Presentation over that one
      // page only — `coerceSettingsHidden()` in `@digilog/shared` is the reader.
      key: 'settingsHidden',
      type: 'json',
      label: 'Hidden on the Settings page',
      description: 'The Instrument ID flag and the attribute keys the Settings widget does not show.',
      default: { instrumentId: false, keys: [] },
      group: 'Attribute Display Names',
    },
  ],
  // The dynamic PUT replaces the whole row and validates nothing by type on its
  // own; this is what refuses an array, a number, or a name that would not fit
  // in a form label. Trimming and case-folding are the reader's job, not the
  // writer's — the row keeps what was typed, the map that leaves is clean.
  zodSchema: z.object({
    labels: z.record(
      z.string().max(ATTRIBUTE_LABEL_KEY_MAX, `An attribute key must be ${ATTRIBUTE_LABEL_KEY_MAX} characters or fewer`),
      z.string().max(ATTRIBUTE_LABEL_MAX, `A display name must be ${ATTRIBUTE_LABEL_MAX} characters or fewer`),
    ),
    // Optional so a client that predates the field still saves; absent reads
    // as nothing hidden (the reader's rule), never as "hide everything".
    settingsHidden: z.object({
      instrumentId: z.boolean(),
      keys: z.array(z.string().max(ATTRIBUTE_LABEL_KEY_MAX, `An attribute key must be ${ATTRIBUTE_LABEL_KEY_MAX} characters or fewer`)),
    }).optional(),
  }).superRefine((v, ctx) => {
    // No two keys and no two names may differ only by case (2026-09-16,
    // operator: "same keys or same display names should not repeat in small
    // letters or capital letters difference also"). Every attribute surface
    // folds case, so two such entries would be one attribute with two names —
    // and the bulk template maps a heading back to a key BY name.
    const keys = new Map<string, string>();
    const names = new Map<string, string>();
    for (const [k, n] of Object.entries(v.labels)) {
      const fk = k.trim().toLowerCase();
      if (keys.has(fk)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Attribute key "${k}" is listed twice ("${keys.get(fk)}"); case is ignored` });
      keys.set(fk, k);
      const fn = n.trim().toLowerCase();
      if (!fn) continue;
      if (names.has(fn)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Display name "${n}" is already used by "${names.get(fn)}"; case is ignored` });
      names.set(fn, k);
    }
  }),
};
