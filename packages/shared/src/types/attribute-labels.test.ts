import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTE_LABELS_CONFIG_KEY, ATTRIBUTE_LABEL_MAX,
  coerceAttributeLabels, attributeLabel,
  coerceSettingsHidden, isHiddenInSettings,
} from './attribute-labels.js';

/**
 * The ONE reader of the `attribute-labels` config row and the ONE lookup every
 * screen uses. A display name is presentation over a stored key: the key stays
 * on the wire, in the CSV and in the audit trail, and only what a person reads
 * changes. Two rules matter and both are pinned here — a blank or missing name
 * falls back to the KEY (never to an empty heading), and the lookup folds case
 * the same way `parseInstrumentAttributeKeys` does, so `Room` and `room` are
 * one attribute here as they are everywhere else.
 */
describe('coerceAttributeLabels', () => {
  it('names the config key the def and the route agree on', () => {
    expect(ATTRIBUTE_LABELS_CONFIG_KEY).toBe('attribute-labels');
  });

  it('reads {labels: {key: name}} and trims both sides', () => {
    expect(coerceAttributeLabels({ labels: { ' Enable_Temp_NMT ': '  High temp alarm enabled ' } }))
      .toEqual({ Enable_Temp_NMT: 'High temp alarm enabled' });
  });

  it('drops a blank name, a blank key and a non-string value', () => {
    expect(coerceAttributeLabels({
      labels: { Building: '', '   ': 'x', Area: 42, Location: 'Room' },
    })).toEqual({ Location: 'Room' });
  });

  it('keeps the FIRST spelling when two keys differ only by case', () => {
    expect(coerceAttributeLabels({ labels: { Room: 'Cleanroom', room: 'Other' } }))
      .toEqual({ Room: 'Cleanroom' });
  });

  it('returns an empty map for anything that is not the stored shape', () => {
    expect(coerceAttributeLabels(undefined)).toEqual({});
    expect(coerceAttributeLabels(null)).toEqual({});
    expect(coerceAttributeLabels('x')).toEqual({});
    expect(coerceAttributeLabels([])).toEqual({});
    expect(coerceAttributeLabels({ labels: [] })).toEqual({});
    expect(coerceAttributeLabels({ labels: 'x' })).toEqual({});
  });

  it('truncates a name longer than the administered maximum rather than dropping it', () => {
    const long = 'x'.repeat(ATTRIBUTE_LABEL_MAX + 10);
    expect(coerceAttributeLabels({ labels: { k: long } }).k).toHaveLength(ATTRIBUTE_LABEL_MAX);
  });
});

describe('attributeLabel', () => {
  const labels = { Enable_Temp_NMT: 'High temp alarm enabled', Building: 'Site building' };

  it('returns the display name for a configured key', () => {
    expect(attributeLabel(labels, 'Enable_Temp_NMT')).toBe('High temp alarm enabled');
  });

  it('falls back to the KEY itself when no name is configured', () => {
    expect(attributeLabel(labels, 't_ll')).toBe('t_ll');
  });

  it('matches the key case-insensitively, the way keys are de-duplicated everywhere', () => {
    expect(attributeLabel(labels, 'building')).toBe('Site building');
  });

  it('tolerates an unloaded map so a slow config fetch cannot blank a label', () => {
    expect(attributeLabel(undefined, 'Building')).toBe('Building');
  });

  it('never returns an empty string for a non-empty key', () => {
    expect(attributeLabel({ Building: '' }, 'Building')).toBe('Building');
  });
});

/**
 * Which fields the SETTINGS page shows (2026-09-21, operator: "in that
 * configuration page any attribute or any field hide, then that field should
 * not show in the settings page"). Stored on the same row as the display
 * names, as the HIDDEN set — so a key nobody has considered shows, and hiding
 * is the deliberate act. Presentation over the Settings widget only; the
 * attribute is still stored, still served, still on the instrument page.
 */
describe('coerceSettingsHidden', () => {
  it('reads the hidden Instrument ID flag and the hidden keys, trimmed', () => {
    expect(coerceSettingsHidden({ labels: {}, settingsHidden: { instrumentId: true, keys: [' Building ', 'Area'] } }))
      .toEqual({ instrumentId: true, keys: ['Building', 'Area'] });
  });

  it('defaults to nothing hidden — an unset row, an older row, or a malformed one', () => {
    const none = { instrumentId: false, keys: [] };
    expect(coerceSettingsHidden(undefined)).toEqual(none);
    expect(coerceSettingsHidden(null)).toEqual(none);
    expect(coerceSettingsHidden({ labels: { Room: 'Cleanroom' } })).toEqual(none);
    expect(coerceSettingsHidden({ settingsHidden: 'x' })).toEqual(none);
    expect(coerceSettingsHidden({ settingsHidden: [] })).toEqual(none);
    expect(coerceSettingsHidden({ settingsHidden: { instrumentId: 'yes', keys: 'Building' } })).toEqual(none);
  });

  it('drops blank and non-string keys and keeps the FIRST spelling of a case-duplicate', () => {
    expect(coerceSettingsHidden({ settingsHidden: { instrumentId: false, keys: ['Room', '  ', 42, 'room'] } }))
      .toEqual({ instrumentId: false, keys: ['Room'] });
  });
});

describe('isHiddenInSettings', () => {
  const hidden = { instrumentId: false, keys: ['Enable_Temp_NMT'] };

  it('is true for a hidden key, matched case-insensitively like every other attribute surface', () => {
    expect(isHiddenInSettings(hidden, 'Enable_Temp_NMT')).toBe(true);
    expect(isHiddenInSettings(hidden, 'enable_temp_nmt')).toBe(true);
  });

  it('is false for a key that is not hidden and while the set has not loaded', () => {
    expect(isHiddenInSettings(hidden, 'Building')).toBe(false);
    expect(isHiddenInSettings(undefined, 'Enable_Temp_NMT')).toBe(false);
  });
});
