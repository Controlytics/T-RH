import { describe, it, expect } from 'vitest';
import { backgroundLayerStyle, resolveOpacity, withAlpha } from '../background-style.js';

describe('withAlpha', () => {
  it('converts a 6-digit hex to rgba', () => {
    expect(withAlpha('#1e3a5f', 0.85)).toBe('rgba(30, 58, 95, 0.85)');
  });

  it('is case-insensitive', () => {
    expect(withAlpha('#FFFFFF', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  /**
   * The branding colours are operator-typed and this repo has already shipped
   * config values that drifted from their expected shape. A malformed colour must
   * degrade to the original string — the sidebar then renders opaque, which is the
   * pre-existing appearance, rather than becoming an invalid gradient that paints
   * nothing and leaves the nav unreadable.
   */
  it('returns the input unchanged when it is not a 6-digit hex', () => {
    expect(withAlpha('red', 0.5)).toBe('red');
    expect(withAlpha('#fff', 0.5)).toBe('#fff');
    expect(withAlpha('', 0.5)).toBe('');
    expect(withAlpha(undefined as unknown as string, 0.5)).toBe('');
  });

  it('clamps alpha to 0..1', () => {
    expect(withAlpha('#000000', 5)).toBe('rgba(0, 0, 0, 1)');
    expect(withAlpha('#000000', -2)).toBe('rgba(0, 0, 0, 0)');
  });
});

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

  /**
   * `fixed` positions the image against the VIEWPORT. Combined with `contain` that
   * letterboxes it against the whole window, so inside the content pane the image
   * appears to begin partway down — which is exactly the defect this pins. The layer
   * is a non-scrolling element sized to the pane, so `scroll` centres the image
   * within the pane. It stays put while content scrolls because the layer is
   * OUTSIDE the scrolling element, not because of this property.
   */
  it('positions against its own box, not the viewport', () => {
    expect(backgroundLayerStyle({ backgroundUrl: '/x.png' })!.backgroundAttachment).toBe('scroll');
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
