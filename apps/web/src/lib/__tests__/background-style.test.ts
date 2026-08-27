import { describe, it, expect } from 'vitest';
import { backgroundLayerStyle, resolveOpacity } from '../background-style.js';

describe('resolveOpacity', () => {
  it('passes a normal value through', () => {
    expect(resolveOpacity(30)).toBe(30);
  });

  it('falls back when absent or unparseable', () => {
    expect(resolveOpacity(undefined)).toBe(12);
    expect(resolveOpacity(null)).toBe(12);
    expect(resolveOpacity('nonsense')).toBe(12);
    expect(resolveOpacity(NaN)).toBe(12);
  });

  it('clamps out-of-range values rather than trusting stored config', () => {
    // The server bounds this, but config rows predate validators in this repo and a
    // value above 100 would paint an opaque sheet over the whole app.
    expect(resolveOpacity(-40)).toBe(0);
    expect(resolveOpacity(400)).toBe(100);
  });

  it('floors a fractional value', () => {
    expect(resolveOpacity(12.9)).toBe(12);
  });

  it('accepts a numeric string, since config values round-trip through JSON', () => {
    expect(resolveOpacity('25')).toBe(25);
  });
});

describe('backgroundLayerStyle', () => {
  /**
   * Absent must mean absent. The layer is position:fixed over the whole viewport;
   * rendering a transparent one unconditionally would put an element above the
   * page's own background on every install that never set an image.
   */
  it('returns null when nothing is configured', () => {
    expect(backgroundLayerStyle(null)).toBeNull();
    expect(backgroundLayerStyle(undefined)).toBeNull();
    expect(backgroundLayerStyle({})).toBeNull();
    expect(backgroundLayerStyle({ backgroundUrl: '' })).toBeNull();
    expect(backgroundLayerStyle({ backgroundUrl: '   ' })).toBeNull();
  });

  it('builds the layer when a url is set', () => {
    const style = backgroundLayerStyle({ backgroundUrl: '/uploads/branding/a.png', backgroundOpacity: 30 })!;
    expect(style.backgroundImage).toBe('url("/uploads/branding/a.png")');
    expect(style.opacity).toBeCloseTo(0.3);
  });

  it('shows the whole image rather than cropping it', () => {
    const style = backgroundLayerStyle({ backgroundUrl: '/uploads/branding/a.png' })!;
    expect(style.backgroundSize).toBe('contain');
    expect(style.backgroundRepeat).toBe('no-repeat');
    expect(style.backgroundPosition).toBe('center');
  });

  it('stays put while content scrolls', () => {
    expect(backgroundLayerStyle({ backgroundUrl: '/x.png' })!.backgroundAttachment).toBe('fixed');
  });

  it('uses the low default strength when none is stored', () => {
    // An unconfigured install must not get a full-strength photograph behind a
    // dense table with no in-app remedy.
    expect(backgroundLayerStyle({ backgroundUrl: '/x.png' })!.opacity).toBeCloseTo(0.12);
  });

  /**
   * A filename is operator-controlled. `url(...)` is a CSS context, so a value
   * containing a quote or a paren could otherwise close the function and inject a
   * further declaration.
   */
  it('quotes the url so a hostile filename cannot break out of url()', () => {
    const style = backgroundLayerStyle({ backgroundUrl: '/a".png);color:red;background-image:url("x' })!;
    expect(String(style.backgroundImage).startsWith('url("')).toBe(true);
    expect(String(style.backgroundImage).endsWith('")')).toBe(true);
    // The embedded quote is escaped, so it cannot terminate the CSS string.
    expect(style.backgroundImage).toContain('\\"');
  });
});
