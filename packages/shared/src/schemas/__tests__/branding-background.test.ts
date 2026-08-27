import { describe, it, expect } from 'vitest';
import { brandingConfigSchema } from '../config.js';

/**
 * The dashboard background image (2026-08-27).
 *
 * Two fields on the EXISTING branding config rather than a new def: the surface is
 * already SUPER_ADMIN-only and already audited on write, so this needs no new
 * permission and no new config module.
 */
describe('branding background', () => {
  it('defaults to no background', () => {
    const parsed = brandingConfigSchema.parse({});
    expect(parsed.backgroundUrl).toBe('');
  });

  it('defaults the scrim to a legible strength', () => {
    // The dashboard is dense — tables, charts, the floorplan. A background at full
    // strength behind that is unreadable, so an unconfigured install must not get one.
    const parsed = brandingConfigSchema.parse({});
    expect(parsed.backgroundOpacity).toBe(12);
  });

  it('accepts a relative upload URL', () => {
    const parsed = brandingConfigSchema.parse({ backgroundUrl: '/uploads/branding/abc.png' });
    expect(parsed.backgroundUrl).toBe('/uploads/branding/abc.png');
  });

  it('accepts an empty string as "no background"', () => {
    expect(brandingConfigSchema.parse({ backgroundUrl: '' }).backgroundUrl).toBe('');
  });

  it('clamps opacity to 0..100', () => {
    expect(brandingConfigSchema.safeParse({ backgroundOpacity: -1 }).success).toBe(false);
    expect(brandingConfigSchema.safeParse({ backgroundOpacity: 101 }).success).toBe(false);
    expect(brandingConfigSchema.parse({ backgroundOpacity: 0 }).backgroundOpacity).toBe(0);
    expect(brandingConfigSchema.parse({ backgroundOpacity: 100 }).backgroundOpacity).toBe(100);
  });

  it('requires opacity to be an integer', () => {
    expect(brandingConfigSchema.safeParse({ backgroundOpacity: 12.5 }).success).toBe(false);
  });

  /**
   * The URL is bounded far below `logoUrl`'s 3,000,000 on purpose. The logo is stored
   * as a base64 data URI; a background is NOT — it is uploaded to disk and only its
   * path is stored. A cap that permitted a data URI here would silently re-admit the
   * multi-megabyte value into `system_config` and into every audited before/after
   * record of a branding change.
   */
  it('refuses a base64 data URI, so an image cannot be smuggled into system_config', () => {
    const dataUri = `data:image/png;base64,${'A'.repeat(4000)}`;
    expect(brandingConfigSchema.safeParse({ backgroundUrl: dataUri }).success).toBe(false);
  });
});
