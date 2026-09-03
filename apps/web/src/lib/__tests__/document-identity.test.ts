import { describe, it, expect, beforeEach } from 'vitest';
import { applyDocumentIdentity, faviconMimeType } from '../document-identity';

/**
 * The browser tab (2026-09-03). These assertions are the substitute for looking at
 * the screen: on this project the operator holds the only browser session, so the
 * DOM effect of a branding change is checked here or nowhere.
 *
 * The head is rebuilt to match `apps/web/index.html` before each case, so "leaves
 * the shipped default alone" is a claim about the real shipped markup and not about
 * an empty document.
 */
const SHIPPED_TITLE = 'T&RH-Monitoring';
const SHIPPED_ICON = '/pwa-192x192.png';
const SHIPPED_APPLE_ICON = '/apple-touch-icon.png';

function resetHead() {
  document.head.innerHTML = `
    <meta name="apple-mobile-web-app-title" content="${SHIPPED_TITLE}" />
    <link rel="icon" type="image/png" href="${SHIPPED_ICON}" />
    <link rel="apple-touch-icon" href="${SHIPPED_APPLE_ICON}" />
  `;
  document.title = SHIPPED_TITLE;
}

const icon = () => document.head.querySelector('link[rel="icon"]')!;
const appleIcon = () => document.head.querySelector('link[rel="apple-touch-icon"]')!;
const appleTitle = () => document.head.querySelector('meta[name="apple-mobile-web-app-title"]')!;

describe('applyDocumentIdentity', () => {
  beforeEach(resetHead);

  it('puts the administered title in the tab', () => {
    applyDocumentIdentity(document, 'Plant 2 Monitoring', '');
    expect(document.title).toBe('Plant 2 Monitoring');
  });

  // The requested title. An ampersand assigned to document.title is a literal
  // ampersand — it must NOT be entity-escaped the way index.html's static tag is.
  it('keeps an ampersand literal in the tab title', () => {
    applyDocumentIdentity(document, 'T&RH-Monitoring', '');
    expect(document.title).toBe('T&RH-Monitoring');
    expect(document.title).not.toContain('&amp;');
  });

  it('leaves the shipped title alone when the administered one is blank', () => {
    applyDocumentIdentity(document, '   ', '');
    expect(document.title).toBe(SHIPPED_TITLE);
  });

  it('repoints BOTH icon links at the uploaded favicon', () => {
    applyDocumentIdentity(document, 'x', '/uploads/branding/abc.png');
    expect(icon().getAttribute('href')).toBe('/uploads/branding/abc.png');
    expect(appleIcon().getAttribute('href')).toBe('/uploads/branding/abc.png');
  });

  /**
   * Blank is the state of a fresh install — nobody has uploaded an icon yet.
   * Clearing `href` here would give every tab a broken-image icon.
   */
  it('leaves the shipped icons alone when no favicon is administered', () => {
    applyDocumentIdentity(document, 'x', '');
    expect(icon().getAttribute('href')).toBe(SHIPPED_ICON);
    expect(appleIcon().getAttribute('href')).toBe(SHIPPED_APPLE_ICON);
  });

  /**
   * The static tag ships `type="image/png"`. Swapping in an .ico while still
   * advertising PNG is the mismatch that presents as "I uploaded my icon and
   * nothing happened".
   */
  it('rewrites the type hint to match an uploaded .ico', () => {
    applyDocumentIdentity(document, 'x', '/uploads/branding/abc.ico');
    expect(icon().getAttribute('type')).toBe('image/x-icon');
  });

  it('drops a stale type hint rather than advertising the wrong one', () => {
    applyDocumentIdentity(document, 'x', '/uploads/branding/abc');
    expect(icon().getAttribute('href')).toBe('/uploads/branding/abc');
    expect(icon().hasAttribute('type')).toBe(false);
  });

  // A document that has lost its icon link (or an embedding that never had one)
  // must still end up with the administered icon.
  it('creates an icon link when the document has none', () => {
    document.head.innerHTML = '';
    applyDocumentIdentity(document, 'x', '/uploads/branding/abc.webp');
    expect(icon().getAttribute('href')).toBe('/uploads/branding/abc.webp');
    expect(appleIcon().getAttribute('href')).toBe('/uploads/branding/abc.webp');
  });

  it('leaves exactly one link per rel, however many times it runs', () => {
    applyDocumentIdentity(document, 'x', '/uploads/branding/a.png');
    applyDocumentIdentity(document, 'x', '/uploads/branding/b.png');
    applyDocumentIdentity(document, 'x', '/uploads/branding/b.png');
    expect(document.head.querySelectorAll('link[rel="icon"]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel="apple-touch-icon"]')).toHaveLength(1);
    expect(icon().getAttribute('href')).toBe('/uploads/branding/b.png');
  });

  /**
   * The one behaviour jsdom can check that actually decides whether the operator
   * sees their new icon. A browser does not reliably repaint the tab when an
   * existing link's `href` is merely rewritten — the element has to be swapped.
   * Asserting on the attribute alone would pass for the version that does not work.
   */
  it('REPLACES the link element when the icon changes, rather than mutating it', () => {
    applyDocumentIdentity(document, 'x', '/uploads/branding/a.png');
    const before = icon();
    applyDocumentIdentity(document, 'x', '/uploads/branding/b.png');
    expect(icon()).not.toBe(before);
    expect(before.isConnected).toBe(false);
  });

  /**
   * The other half of that: several components call useBranding() on one page, so
   * this runs repeatedly with the SAME value and must not churn the head each time.
   */
  it('leaves the element untouched when the icon has not changed', () => {
    applyDocumentIdentity(document, 'x', '/uploads/branding/a.png');
    const before = icon();
    applyDocumentIdentity(document, 'x', '/uploads/branding/a.png');
    expect(icon()).toBe(before);
  });

  // The name under an iOS home-screen icon. Not the PWA manifest — that is baked
  // at build time — but it would otherwise sit on the previous product name for good.
  it('carries the title into the iOS home-screen name', () => {
    applyDocumentIdentity(document, 'Plant 2 Monitoring', '');
    expect(appleTitle().getAttribute('content')).toBe('Plant 2 Monitoring');
  });

  it('never invents the iOS meta tag when the document has none', () => {
    document.head.innerHTML = '';
    applyDocumentIdentity(document, 'Plant 2 Monitoring', '');
    expect(document.head.querySelector('meta[name="apple-mobile-web-app-title"]')).toBeNull();
  });
});

describe('faviconMimeType', () => {
  it('maps every extension the upload route can produce', () => {
    expect(faviconMimeType('/uploads/branding/a.png')).toBe('image/png');
    expect(faviconMimeType('/uploads/branding/a.jpg')).toBe('image/jpeg');
    expect(faviconMimeType('/uploads/branding/a.gif')).toBe('image/gif');
    expect(faviconMimeType('/uploads/branding/a.webp')).toBe('image/webp');
    expect(faviconMimeType('/uploads/branding/a.ico')).toBe('image/x-icon');
  });

  it('is case insensitive and ignores a query string', () => {
    expect(faviconMimeType('/uploads/branding/A.ICO')).toBe('image/x-icon');
    expect(faviconMimeType('/uploads/branding/a.png?v=2')).toBe('image/png');
  });

  it('returns null for an unrecognised extension', () => {
    expect(faviconMimeType('/uploads/branding/a.svg')).toBeNull();
    expect(faviconMimeType('/uploads/branding/noext')).toBeNull();
  });
});
