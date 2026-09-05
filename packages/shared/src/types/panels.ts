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
 *
 * Earlier still, EIGHT filter-domain keys (filter_analytics, total_filters,
 * active_cycles, completed_today, stage_distribution, cycle_status, daily_chart,
 * monthly_chart) went with the Filter Cleaning Analytics block: the
 * `/api/filters/dashboard-stats` feed behind them was removed in the Phase 0
 * strip, so those toggles controlled cards that could never render. Recorded here
 * because it is the same failure twice — a catalogue outliving what it describes.
 *
 * `dashboard_trend` was REMOVED on 2026-08-29 (operator: "remove trend widgets
 * below the tabular view"). Removing it from THIS list is what takes it off the
 * dashboard: `resolveLayout` narrows every stored layout to `DASHBOARD_PANEL_KEYS`,
 * which is derived from here, and `isPanelKey` rejects it when a saved layout is
 * parsed — so an existing layout that still names it drops the entry AND its
 * space, rather than rendering an empty card. Nothing needed migrating.
 *
 * `dashboard_trend` and `dashboard_alarms` were APPENDED to the dashboard group on
 * 2026-08-28 rather than inserted, because the order above is asserted and churning
 * it buys nothing. A role holding an explicit list does NOT get them until an admin
 * ticks them, and there is no migration: absence of a key already means "not
 * shown", which is the right default for new capability. That is the opposite of
 * what the trend keys needed in Project A, where the panels were already visible
 * and carrying only the dashboard keys would have TAKEN something away.
 */
export const PANELS: readonly PanelDefinition[] = [
  {
    key: 'telemetry_table',
    page: 'dashboard',
    label: 'Instrument Readings — Table',
    description: 'Every instrument’s current temperature and humidity, as a table',
  },
  {
    // The history widget (operator, 2026-09-05): Block / Area / instrument
    // selection, the merged readings of the selection, and the Data Report for
    // an Area or a ticked subset. Sits under the readings table by default.
    key: 'dashboard_history',
    page: 'dashboard',
    label: 'Instrument History',
    description: 'Readings of a Block, an Area or chosen instruments over a period, with the Data Report download',
  },
  {
    key: 'telemetry_floorplan',
    page: 'dashboard',
    label: 'Instrument Readings — Floorplan',
    description: 'Rooms drawn on the floor layout, coloured by whether they are in limit',
  },
  {
    key: 'dashboard_alarms',
    page: 'dashboard',
    label: 'Active alarms in this selection',
    description: 'Alarms currently raised on the instruments in the current drill-down',
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
