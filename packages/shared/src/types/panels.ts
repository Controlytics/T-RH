/**
 * Which panels a role or user may SEE on the dashboard and the instrument trend
 * page.
 *
 * Design: docs/superpowers/specs/2026-08-28-panel-assignment-design.md
 *
 * **A hidden panel is a DISPLAY decision, not an access control.** Hiding the
 * historian table does not stop its data being fetched from
 * `GET /api/instruments/:id/telemetry` by anyone who can reach the API.
 * `instrument_scope` is what restricts data; this restricts clutter. The editor
 * screen says so out loud, because an admin who hides the alarms widget believing
 * they have withheld alarm data has been misled by the UI.
 *
 * This file is the ONE catalogue. It replaced two hand-maintained copies (an
 * `ALL_CARDS` array in the web config page and a `VALID_CARD_KEYS` set in the API
 * route) that carried a "keep in sync" comment — which is a drift with a comment
 * on it, not a solution.
 */

export type PanelPage = 'dashboard' | 'trend';

export interface PanelDefinition {
  key: string;
  page: PanelPage;
  label: string;
  description: string;
}

export const PANEL_PAGES: readonly { page: PanelPage; label: string }[] = [
  { page: 'dashboard', label: 'Dashboard' },
  { page: 'trend', label: 'Instrument trend page' },
] as const;

/**
 * ORDER IS PART OF THE CONTRACT — a frozen test asserts it, because these keys are
 * stored in `role_configs` / `user_configs` and renaming one silently orphans every
 * saved row that names it.
 *
 * The four keys retired on 2026-08-28 — `total_users`, `audit_trail`,
 * `notifications`, `quick_actions` — gated dashboard sections that no longer exist.
 * They are deliberately absent, not commented out.
 */
export const PANELS: readonly PanelDefinition[] = [
  {
    key: 'telemetry_table',
    page: 'dashboard',
    label: 'Instrument Readings — Table',
    description: 'Every instrument’s current temperature and humidity, as a table',
  },
  {
    key: 'telemetry_floorplan',
    page: 'dashboard',
    label: 'Instrument Readings — Floorplan',
    description: 'Rooms drawn on the floor layout, coloured by whether they are in limit',
  },
  {
    key: 'trend_gauges',
    page: 'trend',
    label: 'Band gauges',
    description: 'Latest temperature and humidity against their limits',
  },
  {
    key: 'trend_charts',
    page: 'trend',
    label: 'Trend charts',
    description: 'Temperature and humidity plotted over the selected period',
  },
  {
    key: 'trend_summary',
    page: 'trend',
    label: 'Chart summary strips',
    description: 'Min / max / average and out-of-limit counts beneath each chart',
  },
  {
    key: 'trend_historian_table',
    page: 'trend',
    label: 'Time series (raw readings)',
    description: 'The paged historian table of every stored reading in the period',
  },
  {
    key: 'trend_alarms',
    page: 'trend',
    label: 'Alarms in this period',
    description: 'Alarms raised on this instrument during the selected period',
  },
] as const;

export const PANEL_KEYS: readonly string[] = PANELS.map((p) => p.key);

export type PanelKey = (typeof PANELS)[number]['key'];

const KEY_SET = new Set<string>(PANEL_KEYS);

export function isPanelKey(v: unknown): v is PanelKey {
  return typeof v === 'string' && KEY_SET.has(v);
}

/**
 * Read a stored `dashboard_cards` value, or `undefined` for "nothing stored here".
 *
 * Absent OR malformed both mean INHERIT, not deny — a corrupted value must not
 * blank someone's screen, which is an outage presenting as a configuration change.
 *
 * An EMPTY result stays empty. Returning `undefined` for `[]` would turn every
 * deliberate "no panels" row into "every panel", which is the wrong direction to
 * fail in and the reason this function exists at all rather than an inline filter.
 *
 * A key no longer in the catalogue contributes NOTHING and is never a wildcard.
 */
export function normalizePanels(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.filter(isPanelKey);
}

/**
 * The effective panel list, or `null` for "every panel".
 *
 * Mirrors `modules/instruments/visibility.ts:effectiveScope` deliberately: the
 * user's list REPLACES the role's rather than intersecting it, so it can widen as
 * well as narrow. Two governance surfaces edited on the same screen behaving
 * differently would be worse than either rule alone.
 */
export function resolvePanels(
  userRole: string,
  rolePanels: string[] | null | undefined,
  userPanels: string[] | null | undefined,
): string[] | null {
  if (userRole === 'SUPER_ADMIN') return null;
  if (userPanels !== null && userPanels !== undefined) return userPanels;
  if (rolePanels !== null && rolePanels !== undefined) return rolePanels;
  return null;
}

/** `null` (unrestricted) shows everything; an empty list shows nothing. */
export function panelVisible(resolved: string[] | null, key: string): boolean {
  return resolved === null || resolved.includes(key);
}
