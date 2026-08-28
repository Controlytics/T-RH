import { describe, it, expect } from 'vitest';
import {
  PANEL_TINTS, PANEL_SIZES, PANEL_PADDINGS, MAX_PANEL_TITLE,
  contrastRatio, isTintKey, normalizePanelStyle, tintFor, sizeFor, paddingFor,
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

  it('every tint heading is readable on its HEADER plate, not just on the body', () => {
    // The plate is a shade deeper than the card, so AA against the body does not
    // imply AA against the plate — and the title sits on the plate.
    for (const t of PANEL_TINTS) {
      expect(contrastRatio(t.head, t.text), `${t.key} header plate vs text`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('every rail is a real CSS value, and the default defers to the site theme', () => {
    // `default` carries a var() so an unstyled card wears whichever of the ten
    // themes the operator picked, rather than a fixed grey the theme cannot reach.
    for (const t of PANEL_TINTS) expect(t.rail.length).toBeGreaterThan(3);
    expect(PANEL_TINTS[0].rail).toContain('var(--theme-primary');
    // Every other rail is a literal, so nothing depends on a variable that may
    // not be set on a given page.
    for (const t of PANEL_TINTS.slice(1)) expect(t.rail.startsWith('#')).toBe(true);
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

describe('content size and padding', () => {
  it('reads a size and a padding', () => {
    expect(normalizePanelStyle({ size: 'large', pad: 'roomy' })).toEqual({ size: 'large', pad: 'roomy' });
  });

  it('does not STORE the default — absent already means normal', () => {
    // Storing 'normal' would pin the card to today's default, so changing the
    // default later would not reach the cards that never chose anything.
    expect(normalizePanelStyle({ size: 'normal', pad: 'normal' })).toBeUndefined();
  });

  it('drops a value outside the bounded steps', () => {
    // A free number invites 0.4, which is a card nobody can read.
    expect(normalizePanelStyle({ size: '0.4' })).toBeUndefined();
    expect(normalizePanelStyle({ size: 3 })).toBeUndefined();
    expect(normalizePanelStyle({ pad: '40px' })).toBeUndefined();
  });

  it('falls back to normal for an unknown or absent key', () => {
    // A retired step must render at normal, not pin the card to whatever replaced
    // it in the list.
    expect(sizeFor('gigantic').key).toBe('normal');
    expect(sizeFor(undefined).zoom).toBe(1);
    expect(paddingFor('nope').key).toBe('normal');
  });

  it('keeps every step legible and every padding sane', () => {
    // The bound is only a safeguard if something checks it. Nothing below 0.7
    // survives a table; nothing above 2 fits a card.
    for (const s of PANEL_SIZES) {
      expect(s.zoom).toBeGreaterThanOrEqual(0.7);
      expect(s.zoom).toBeLessThanOrEqual(2);
    }
    for (const p of PANEL_PADDINGS) {
      expect(p.px).toBeGreaterThanOrEqual(0);
      expect(p.px).toBeLessThanOrEqual(48);
    }
    expect(PANEL_SIZES.some((s) => s.zoom === 1)).toBe(true);
  });

  it('combines with a tint and a title', () => {
    expect(normalizePanelStyle({ tint: 'sky', title: 'Cold room', size: 'large', pad: 'tight' }))
      .toEqual({ tint: 'sky', title: 'Cold room', size: 'large', pad: 'tight' });
  });
});
