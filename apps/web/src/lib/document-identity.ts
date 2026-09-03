/**
 * The browser TAB — its title and its icon (2026-09-03).
 *
 * Both are administered on Config -> Branding (`branding.tabTitle` /
 * `branding.faviconUrl`) and applied here, once, from `useBranding()`. The
 * shipped defaults live in `apps/web/index.html` and are what the tab reads
 * before any JS has run; this only ever OVERRIDES them.
 *
 * Split out of the hook as a plain function taking its `Document` so it can be
 * tested in jsdom without mounting the app. That matters on this project
 * specifically: the operator holds the only browser session, so a render/DOM
 * test is the substitute for looking at the screen, not a nicety.
 */

/**
 * Both icon links are rewritten together. Leaving `apple-touch-icon` pointing at
 * the shipped logo while the tab shows a new icon is a half-done rename that
 * surfaces later as "the home-screen icon is still the old one".
 *
 * The PWA MANIFEST's icons are NOT here and cannot be: vite-plugin-pwa bakes them
 * at build time, and an installed app's icon changing underneath the user is not
 * something a config write should be able to do.
 */
const ICON_RELS = ['icon', 'apple-touch-icon'] as const;

/** Extensions the upload route can produce (see MIME_TO_EXT in uploads/routes.ts). */
const EXT_TO_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

/**
 * The `type` hint for a favicon URL, or null when the extension is unrecognised.
 *
 * This exists because the static tag is `type="image/png"`: swapping in an .ico
 * while still advertising PNG is a mismatch Firefox has been known to skip the
 * link over, which presents as "I uploaded my icon and nothing happened".
 */
export function faviconMimeType(url: string): string | null {
  const path = url.split(/[?#]/)[0];
  const dot = path.lastIndexOf('.');
  if (dot < 0) return null;
  return EXT_TO_TYPE[path.slice(dot).toLowerCase()] ?? null;
}

/**
 * Point one icon link at `href`, REPLACING the element rather than mutating it.
 *
 * A browser does not reliably repaint the tab icon when an existing
 * `<link rel="icon">` simply has its `href` attribute rewritten; removing the
 * element and appending a fresh one is the recipe that is actually honoured. That
 * is the whole point of this function, and a "simplification" back to
 * `link.setAttribute('href', …)` would leave the config saving correctly while the
 * tab kept the old icon — a failure with nothing on screen to explain it.
 *
 * It still ends with exactly ONE link per rel, and it SKIPS the swap when the href
 * is already correct — several components call `useBranding()` on one page, so the
 * effect runs repeatedly and must not churn the head each time.
 */
function setIconLink(doc: Document, rel: string, href: string, type: string | null): void {
  const existing = doc.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (existing && existing.getAttribute('href') === href) return;

  const link = doc.createElement('link');
  link.rel = rel;
  link.setAttribute('href', href);
  // Only `rel="icon"` carries a meaningful type hint; apple-touch-icon does not.
  // Absent when the extension is unknown, so a stale hint is dropped rather than
  // carried over onto a file it no longer describes.
  if (rel === 'icon' && type) link.setAttribute('type', type);

  existing?.remove();
  doc.head.appendChild(link);
}

/**
 * Apply the administered tab identity to `doc`.
 *
 * A BLANK value leaves the shipped default in place rather than clearing it —
 * the same rule the rest of this app's administered wording follows. That is not
 * defensive padding: `faviconUrl` is legitimately empty until someone uploads one,
 * and blanking `href` would give every tab a broken-image icon on a fresh install.
 */
export function applyDocumentIdentity(doc: Document, tabTitle: string, faviconUrl: string): void {
  const title = (tabTitle ?? '').trim();
  if (title) {
    doc.title = title;
    // The name under an iOS home-screen icon. Driven from the same value so a
    // rename cannot leave it reading the previous product name; it is a <meta>,
    // NOT part of the PWA manifest, which is baked at build time and deliberately
    // left alone. Only updated if the tag exists — this never invents one.
    doc.head.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', title);
  }

  const href = (faviconUrl ?? '').trim();
  if (!href) return;

  const type = faviconMimeType(href);
  for (const rel of ICON_RELS) setIconLink(doc, rel, href, type);
}
