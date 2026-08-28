import { describe, it, expect } from 'vitest';
import {
  PANEL_TINTS, MAX_PANEL_TITLE, contrastRatio, isTintKey, normalizePanelStyle, tintFor,
} from './panel-style.js';

describe('the palette is bounded AND readable', () => {
  it('every tint meets WCAG AA against its own text colour', () => {
    // The whole justification for a bounded palette over a colour picker. If this
    // ever fails, a tint was added without checking it — do not lower the bar,
    // change the colour.
    for (const t of PANEL_TINTS) {
      expect(contrastRatio(t.bg, t.text), `${t.key} background vs text`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every tint border is distinguishable from its background', () => {
    // A border the same shade as the card is no border, and in edit mode the card
    // outline is how someone sees what they are dragging.
    for (const t of PANEL_TINTS) {
      expect(contrastRatio(t.bg, t.border), `${t.key} background vs border`).toBeGreaterThan(1.1);
    }
  });

  it('has no duplicate keys and a default first', () => {
    const keys = PANEL_TINTS.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('default');
  });

  it('contrastRatio is calibrated against known values', () => {
    // Black on white is the canonical 21:1; a colour against itself is 1:1.
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 0);
    expect(contrastRatio('#3b82f6', '#3b82f6')).toBeCloseTo(1, 5);
  });
});

describe('isTintKey / tintFor', () => {
  it('accepts a palette key and rejects anything else', () => {
    expect(isTintKey('sky')).toBe(true);
    expect(isTintKey('#ff0000')).toBe(false);
    expect(isTintKey(7)).toBe(false);
  });

  it('falls back to the default tint for an unknown or absent key', () => {
    // A retired tint must render as the default card, never as no card at all.
    expect(tintFor('nope').key).toBe('default');
    expect(tintFor(undefined).key).toBe('default');
  });
});

describe('normalizePanelStyle', () => {
  it('reads a tint and a title', () => {
    expect(normalizePanelStyle({ tint: 'sky', title: 'Cold room' }))
      .toEqual({ tint: 'sky', title: 'Cold room' });
  });

  it('drops a colour that is not in the palette', () => {
    // Free hex is exactly what the bounded palette exists to refuse. Someone
    // posting one directly must not get it.
    expect(normalizePanelStyle({ tint: '#00ff00' })).toBeUndefined();
  });

  it('trims and caps a title', () => {
    const long = 'x'.repeat(MAX_PANEL_TITLE + 40);
    expect(normalizePanelStyle({ title: `  ${long}  ` })!.title).toHaveLength(MAX_PANEL_TITLE);
  });

  it('treats a blank title as absent, so the built-in heading returns', () => {
    // Otherwise clearing the field would leave a card with no heading at all, and
    // no way to tell which panel it is.
    expect(normalizePanelStyle({ title: '   ' })).toBeUndefined();
  });

  it('returns undefined when there is nothing usable', () => {
    expect(normalizePanelStyle(null)).toBeUndefined();
    expect(normalizePanelStyle('sky')).toBeUndefined();
    expect(normalizePanelStyle({ colour: 'red' })).toBeUndefined();
  });
});
