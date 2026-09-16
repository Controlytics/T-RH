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
 * Its own page (`/config/attribute-labels`) rather than the dynamic renderer: a
 * key → name table pre-filled with every key in use is a form an admin can fill
 * in; a JSON textarea is a way to make that fail. `hasCustomPage` stays FALSE
 * on purpose — `true` would skip the generic `/dynamic/attribute-labels`
 * GET/PUT, which is the endpoint that validates against `zodSchema`, enforces
 * `requiredRole` and writes the `CONFIG_CHANGED` audit row; the page only needs
 * a different door, and `customPagePath` is what the Configuration index
 * follows.
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
  customPagePath: '/config/attribute-labels',
  settings: [
    {
      key: 'labels',
      type: 'json',
      label: 'Display names',
      description: 'A map of attribute key to the name shown for it. A blank name shows the key itself.',
      default: {},
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
  }),
};
