import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT } from '@digilog/shared';

/**
 * VESTIGIAL as of 2026-08-08 — this key seeds NOTHING and is asked for on no
 * form. A newly created instrument profile now starts with an EMPTY attribute
 * list (operator decision; see `instrument-profiles/routes.ts` POST), because a
 * new profile opening as an identical copy of the last one is what made the
 * per-profile lists read as one global list. The module is kept only so the
 * `/config/instrument-attributes` page — the PER-PROFILE editor — stays
 * discoverable through config auto-discovery and the Configuration Access
 * matrix; deleting it is a separate decision that must first confirm the page
 * does not lose its role gating. Its stored value is inert.
 *
 * What it used to be: the default attribute keys a new profile started with.
 *
 * Instrument attributes are free-form key/value pairs, which is right for the
 * data model and wrong for data entry: left to itself every operator invents
 * their own spelling of the same idea ("Room", "room", "Room No"), and the
 * result is a registry that cannot be filtered on. This turns the KEYS into an
 * administered list while leaving the VALUES to whoever registers the device.
 *
 * Since 2026-08-08 the list a registration form actually asks for lives on the
 * PROFILE (`InstrumentProfile.attributeKeys`), edited per profile on
 * Configuration → Instrument Attributes with a profile picker. See
 * `docs/superpowers/specs/2026-08-08-per-profile-instrument-attributes-design.md`.
 *
 * A newline-separated textarea rather than a JSON setting: an admin editing
 * this is writing a list of words, and JSON punctuation is a way to make that
 * fail. Parsing (trim, drop blanks, de-duplicate) lives in `@digilog/shared` so
 * every consumer agrees on what a line means.
 *
 * The list is a PROMPT, not a constraint. The attributes panel on the detail
 * page still accepts any key, and an instrument created before a key was added
 * simply does not have it — nothing is back-filled and nothing is rejected.
 */
export const instrumentAttributesDef: ModuleConfigDefinition = {
  moduleKey: 'instrument-attributes',
  moduleName: 'Instrument Attributes',
  description: 'Inert since 2026-08-08 — attribute keys live on each instrument profile and are edited on the Instrument Attributes page.',
  icon: 'tag',
  category: 'system',
  sortOrder: 14,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'keys',
      type: 'textarea',
      label: 'Attribute keys',
      description: 'Not used. New profiles start with no attributes, and each profile has its own list, edited on Configuration → Instrument Attributes.',
      default: INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT,
      maxLength: 2000,
      group: 'Instrument Attributes',
    },
    {
      // The DEVICE → platform path (2026-09-05): a device may write its own or
      // its children's attributes on `instruments/<code>/attributes/report`.
      // Which keys it may write is administered here. BLANK = any key, which is
      // what the operator asked for; narrow it to stop firmware from moving a
      // limit the QA people own.
      key: 'deviceWritableKeys',
      type: 'textarea',
      label: 'Device-writable attribute keys',
      description: 'One key per line. Attributes a device may set over MQTT (instruments/<code>/attributes/report). Blank = any key. A key not listed is refused and recorded in the dead-letter log.',
      default: '',
      maxLength: 2000,
      group: 'Device reports',
    },
  ],
};
