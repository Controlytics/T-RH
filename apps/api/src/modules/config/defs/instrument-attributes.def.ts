import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT } from '@digilog/shared';

/**
 * The DEFAULT attribute keys a newly created instrument profile starts with.
 *
 * Instrument attributes are free-form key/value pairs, which is right for the
 * data model and wrong for data entry: left to itself every operator invents
 * their own spelling of the same idea ("Room", "room", "Room No"), and the
 * result is a registry that cannot be filtered on. This turns the KEYS into an
 * administered list while leaving the VALUES to whoever registers the device.
 *
 * Since 2026-08-08 the list a registration form actually asks for lives on the
 * PROFILE (`InstrumentProfile.attributeKeys`). This key is only the template a
 * new profile is seeded from, and is asked for on no form by itself. Both are
 * edited on the same page, Configuration → Instrument Attributes, chosen with a
 * picker. See
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
  description: 'The attribute keys a new instrument profile starts with. Each profile\'s own list is edited on the same page.',
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
      description: 'One key per line, in the order they should appear on the form. Blank lines and duplicates are ignored. Copied into each new profile; leave empty for new profiles to start with none.',
      default: INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT,
      maxLength: 2000,
      group: 'Instrument Attributes',
    },
  ],
};
