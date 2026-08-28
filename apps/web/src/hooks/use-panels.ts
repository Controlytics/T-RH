import useSWR from 'swr';
import { panelVisible } from '@digilog/shared';

/**
 * Which panels this user may see.
 *
 * The RESOLUTION (inherit → role → user, and SUPER_ADMIN's bypass) happens on the
 * server and rides on `/api/config/my-config`. Nothing here re-derives it — that is
 * a policy decision, and this repo has been bitten before by a client that
 * recomputed one and drifted from the server.
 *
 * Applying the resulting list to the layout IS this file's job, and is correct
 * here: hiding a panel is a display decision, not an access control. The data
 * behind a hidden panel is still reachable from the API; `instrument_scope` is what
 * restricts it.
 *
 * Replaces the old `/api/config/dashboard-cards/current` fetch, which had no
 * per-user layer and which did the role lookup in the browser.
 */

/** `undefined` = not loaded yet. `null` = every panel. */
export function showPanelFrom(panels: string[] | null | undefined, key: string): boolean {
  // Not loaded yet shows everything. Flashing the panels away and back on every
  // page load is worse than a moment of over-showing, and hiding everything until
  // the fetch lands makes a slow network look like a broken dashboard. Safe only
  // because this is a display preference; a data restriction must never be
  // optimistic in this direction.
  if (panels === undefined) return true;
  return panelVisible(panels, key);
}

export function usePanels() {
  const { data } = useSWR<{ panels?: string[] | null }>('/api/config/my-config');
  const panels = data === undefined ? undefined : data.panels ?? null;
  return {
    showPanel: (key: string) => showPanelFrom(panels, key),
    loaded: data !== undefined,
  };
}
