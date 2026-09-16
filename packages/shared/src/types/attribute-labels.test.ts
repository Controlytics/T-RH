import { describe, it, expect } from 'vitest';
import {
  ATTRIBUTE_LABELS_CONFIG_KEY, ATTRIBUTE_LABEL_MAX,
  coerceAttributeLabels, attributeLabel,
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
