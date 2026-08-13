/**
 * Per-module colour palettes — the PAGE half of this app's colour system.
 *
 * DIVISION OF RESPONSIBILITY (do not cross these):
 *   --theme-*  (lib/themes.ts)  owns CHROME: sidebar, login screen, primary buttons.
 *   --mod-*    (this file)      owns PAGE:   canvas, cards, tables, stat tiles, bands.
 *
 * This app already carried two overlapping colour systems (THEMES plus the
 * Branding config) and they disagreed about what a theme controls. Adding a third
 * without a written boundary is how that happened; don't.
 *
 * `tableHead` is a 700-level colour and is deliberately NOT `from`. White body
 * text on the 600-level `from` values measures 2.94-3.77:1 — five of these eleven
 * palettes fail WCAG AA that way. `module-palettes.test.ts` enforces the
 * distinction, so deleting `tableHead` to "simplify" will fail the suite rather
 * than silently ship five inaccessible tables.
 */

export interface ModulePalette {
  id: string;
  label: string;
  /** Route prefixes owning this palette. Longest match wins. */
  prefixes: string[];
  /** Gradient start, 600-level. Surface tints are derived from this in app.css. */
  from: string;
  /** Gradient end, 600-level. Large text only — some pairs sit near 3:1. */
  to: string;
  /** Solid table-header band, 700-level. See the note above before changing. */
  tableHead: string;
  /** Heading text on tinted surfaces, 950-level. */
  text: string;
  /** Secondary heading text, 800-level. */
  muted: string;
}

export const MODULE_PALETTES: ModulePalette[] = [
  { id: 'dashboard',      label: 'Dashboard',      prefixes: ['/'],               from: '#4f46e5', to: '#7c3aed', tableHead: '#4338ca', text: '#1e1b4b', muted: '#3730a3' },
  { id: 'home',           label: 'Module Guide',   prefixes: ['/home'],           from: '#2563eb', to: '#0284c7', tableHead: '#0369a1', text: '#172554', muted: '#1e40af' },
  { id: 'instruments',    label: 'Instruments',    prefixes: ['/instruments'],    from: '#0891b2', to: '#0d9488', tableHead: '#0f766e', text: '#083344', muted: '#155e75' },
  { id: 'audit',          label: 'Audit Trail',    prefixes: ['/audit'],          from: '#d97706', to: '#ea580c', tableHead: '#b45309', text: '#451a03', muted: '#92400e' },
  { id: 'config',         label: 'Configuration',  prefixes: ['/config'],         from: '#059669', to: '#16a34a', tableHead: '#047857', text: '#022c22', muted: '#065f46' },
  { id: 'users',          label: 'Users',          prefixes: ['/users'],          from: '#db2777', to: '#e11d48', tableHead: '#be185d', text: '#500724', muted: '#9d174d' },
  { id: 'notifications',  label: 'Notifications',  prefixes: ['/notifications'],  from: '#7c3aed', to: '#c026d3', tableHead: '#7e22ce', text: '#2e1065', muted: '#5b21b6' },
  // from is yellow-700, not yellow-600: white on #ca8a04 measures 2.94:1 and
  // fails even the 3:1 large-text floor, so a gradient header band would have
  // been unreadable. Caught by the test, not by looking at it.
  { id: 'admin-requests', label: 'Admin Requests', prefixes: ['/admin-requests'], from: '#a16207', to: '#65a30d', tableHead: '#854d0e', text: '#422006', muted: '#854d0e' },
  { id: 'profile',        label: 'Profile',        prefixes: ['/profile'],        from: '#9333ea', to: '#7c3aed', tableHead: '#7e22ce', text: '#3b0764', muted: '#6b21a8' },
  { id: 'system-health',  label: 'System Health',  prefixes: ['/system-health'],  from: '#0d9488', to: '#059669', tableHead: '#0f766e', text: '#042f2e', muted: '#115e59' },
  { id: 'debug',          label: 'Debug Traces',   prefixes: ['/debug'],          from: '#475569', to: '#334155', tableHead: '#334155', text: '#0f172a', muted: '#334155' },
];

/**
 * Neutral palette for any route not claimed above. Chosen to match the app's
 * pre-existing slate look, so a route added later degrades to today's appearance
 * rather than to an arbitrary hue.
 */
export const FALLBACK_PALETTE: ModulePalette = {
  id: 'fallback',
  label: 'Default',
  prefixes: [],
  from: '#475569',
  to: '#334155',
  tableHead: '#334155',
  text: '#0f172a',
  muted: '#334155',
};

/**
 * Longest-prefix match. `/config/floorplans` must resolve to `config` and must
 * not fall through to the `/` dashboard entry — hence the length sort, and hence
 * `/` only ever matching exactly.
 */
export function resolveModulePalette(pathname: string): ModulePalette {
  if (pathname === '/') return MODULE_PALETTES[0];

  const matches = MODULE_PALETTES
    .flatMap((palette) => palette.prefixes
      .filter((prefix) => prefix !== '/')
      .map((prefix) => ({ palette, prefix })))
    .filter(({ prefix }) => pathname === prefix || pathname.startsWith(prefix + '/'))
    .sort((a, b) => b.prefix.length - a.prefix.length);

  return matches[0]?.palette ?? FALLBACK_PALETTE;
}
