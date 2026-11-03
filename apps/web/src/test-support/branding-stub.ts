import { vi } from 'vitest';

/**
 * Branding, as a report being made NOW reads it (ruling F-1, extended
 * 2026-11-03): `GET /api/config/branding` and the Branding logo it names. A
 * fresh report REFUSES when either cannot be read (`lib/pdf-report.ts`), so a
 * test that builds one must answer both — before this, an unanswered fetch in
 * jsdom quietly printed the shipped names and no logo, the very fallback the
 * ruling forbids on a signed record.
 *
 * By default Branding names nothing (the report prints the shipped default
 * company and app names, as the frozen page-report fixtures expect) and the
 * logo is `/logo.jpg`, the bundled default. Any other URL rejects, as an
 * unanswered request does in jsdom.
 */

/** A real 3 x 1 PNG — the logo. Distinct from every chart / sample PNG the tests count. */
export const BRANDING_LOGO_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAMAAAABCAIAAACUgoPjAAAADUlEQVR4nGM4IScHQQARRAMN1Pc8CwAAAABJRU5ErkJggg==';

const LOGO_BYTES = Uint8Array.from(atob(BRANDING_LOGO_PNG.split(',')[1]), (c) => c.charCodeAt(0));

/** A `fetch` answering Branding (with `branding`) and its logo; any other URL rejects. */
export function brandingFetch(branding: Record<string, unknown> = {}) {
  const logoUrl = typeof branding.logoUrl === 'string' && branding.logoUrl ? branding.logoUrl : '/logo.jpg';
  return vi.fn(async (url: unknown) => {
    const u = String(url);
    if (u.endsWith('/api/config/branding')) return { ok: true, status: 200, json: async () => branding };
    if (u === logoUrl) return { ok: true, status: 200, blob: async () => new Blob([LOGO_BYTES], { type: 'image/png' }) };
    throw new TypeError(`fetch failed: ${u} (not answered by the Branding stub)`);
  });
}

/** Install `brandingFetch(branding)` as the global `fetch`; returns the spy. */
export function stubBrandingFetch(branding: Record<string, unknown> = {}) {
  const spy = brandingFetch(branding);
  vi.stubGlobal('fetch', spy);
  return spy;
}
