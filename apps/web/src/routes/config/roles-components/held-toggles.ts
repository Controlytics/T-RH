/**
 * Which Permissions-tab toggles a save will bring back ON although the user
 * switched them OFF — and what holds each one (2026-11-03, operator: "for some
 * permissions, after un-selecting them and saving, those are not updating").
 *
 * A save rebuilds the role's permissions from the toggles and re-adds the
 * primary permission of every enabled sidebar item (`rebuildRolePermissions`);
 * the tab then reads the toggles back from what the role holds
 * (`privilegeTogglesFromPermissions`). So a toggle whose permission another ON
 * toggle grants (View Users under Edit Users), an implication covers (Edit
 * Settings under Edit Instruments) or an enabled sidebar item grants (View
 * Users under the Users menu) comes straight back. This runs THOSE TWO shared
 * functions — the server's own — and never a copy of either.
 *
 * `currentPermissions: []` is deliberate: a permission no toggle maps is not a
 * toggle, and the tab neither shows nor sends it.
 *
 * Plain .ts (no React), like `permission-tree-grouping.ts`, so it is tested on
 * its own.
 */
import { PERMISSION_TREE, SIDEBAR_ITEMS, privilegeTogglesFromPermissions, rebuildRolePermissions } from '@digilog/shared';

/** What holds one toggle ON: each source that holds it BY ITSELF. */
export interface Holders {
  /** ON toggles, by id, in tree order. */
  toggles: string[];
  /** Enabled sidebar items, by id, in the role's order. */
  sidebarItems: string[];
}

export interface HeldToggles {
  /** Every toggle as the tab will read it after a save of these toggles. */
  shown: Record<string, boolean>;
  /** The toggles OFF in the user's map that `shown` has ON — and what holds each. */
  heldBy: Record<string, Holders>;
}

const settle = (toggles: Record<string, boolean>, sidebarItems: readonly string[]) =>
  privilegeTogglesFromPermissions(rebuildRolePermissions({ currentPermissions: [], toggles, sidebarItems }));

// What ONE source holds by itself. Every rule of `hasEffectivePermission` lets
// a SINGLE permission satisfy a gate (a direct match, an implication, _READ for
// _VIEW, _MANAGE), so a toggle the whole selection holds is held by at least
// one source ALONE — asking each source alone cannot miss a holder. Removing
// one source at a time and re-deriving CAN: View Users stays held while any of
// five Users toggles is ON, so no single removal frees it and the caption would
// name nobody. The tree is constant, so each answer is computed once.
const byToggle = new Map<string, Record<string, boolean>>();
const bySidebarItem = new Map<string, Record<string, boolean>>();
const holdsAlone = (cache: Map<string, Record<string, boolean>>, key: string, compute: () => Record<string, boolean>) => {
  let held = cache.get(key);
  if (!held) { held = compute(); cache.set(key, held); }
  return held;
};

const NODES = PERMISSION_TREE.flatMap(g => g.nodes);
const TREE_ORDER = NODES.filter(n => n.configurable === true).map(n => n.id);
const NODE_LABEL = new Map(NODES.map(n => [n.id, n.label]));
const SIDEBAR_LABEL = new Map(SIDEBAR_ITEMS.map(i => [i.id, i.label]));

export function heldToggles(toggles: Record<string, boolean>, sidebarItems: readonly string[]): HeldToggles {
  const shown = settle(toggles, sidebarItems);
  const heldBy: Record<string, Holders> = {};
  for (const id of Object.keys(shown)) {
    if (!shown[id] || toggles[id]) continue;
    heldBy[id] = {
      toggles: TREE_ORDER.filter(t => t !== id && toggles[t]
        && holdsAlone(byToggle, t, () => settle({ [t]: true }, []))[id]),
      sidebarItems: sidebarItems.filter(s => holdsAlone(bySidebarItem, s, () => settle({}, [s]))[id]),
    };
  }
  return { shown, heldBy };
}

/** "Held by Edit Users", "Held by the Users sidebar item", "Held by Edit Users and the Users sidebar item". */
export function heldCaption(holders: Holders): string {
  const parts: string[] = [];
  if (holders.toggles.length > 0) parts.push(holders.toggles.map(t => NODE_LABEL.get(t) ?? t).join(', '));
  if (holders.sidebarItems.length > 0) {
    const names = holders.sidebarItems.map(s => SIDEBAR_LABEL.get(s) ?? s).join(', ');
    parts.push(`the ${names} sidebar item${holders.sidebarItems.length > 1 ? 's' : ''}`);
  }
  return `Held by ${parts.join(' and ')}`;
}
