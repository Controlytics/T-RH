import { useState } from 'react';
import useSWR from 'swr';
import {
  DEFAULT_DASHBOARD_LAYOUT, widgetIdOf, widgetItemId,
  type CustomWidget, type DashboardLayout, type LayoutItem, type PanelStyle,
} from '@digilog/shared';
import { apiClient } from '@/lib/api-client';

const NO_WIDGETS: CustomWidget[] = [];

/** Where a new widget lands, and how tall it starts: value cards short, the rest medium. */
const WIDGET_START_HEIGHT: Record<CustomWidget['type'], number> = {
  value_cards: 5, latest_table: 9, trend_chart: 9, timeseries_table: 9,
};

/**
 * The dashboard's arrangement, and the edit session over it.
 *
 * The RESOLUTION (this user's layout → their role's default → the built-in, then
 * narrowed to the panels they may see) happens on the server and rides on
 * `/api/config/my-config`. Nothing here re-derives it.
 *
 * The DRAFT lives here rather than being read back from SWR, so Cancel is a real
 * discard: the operator's in-progress arrangement is thrown away and the last
 * saved state returns, without a refetch that might land mid-drag.
 */
export function useDashboardLayout() {
  const { data, mutate } = useSWR<{ layout?: DashboardLayout }>('/api/config/my-config');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<LayoutItem[] | null>(null);
  // Built widgets (2026-10-28) are drafted beside the items, and committed or
  // discarded with them: a widget added and then cancelled must not survive.
  const [draftWidgets, setDraftWidgets] = useState<CustomWidget[] | null>(null);
  const [saving, setSaving] = useState(false);

  const saved = data?.layout ?? DEFAULT_DASHBOARD_LAYOUT;
  // While editing, the draft is the truth. Outside edit mode there is no draft at
  // all, so a background revalidation cannot silently move someone's cards.
  const items = draft ?? saved.items;
  const widgets = draftWidgets ?? saved.widgets ?? NO_WIDGETS;

  const start = () => {
    setDraft(saved.items);
    setDraftWidgets(saved.widgets ?? []);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(null);
    setDraftWidgets(null);
    setEditing(false);
  };

  /** The arrangement on screen, in the shape both layout routes take. */
  const current = (): DashboardLayout => ({ version: saved.version, items, widgets });

  const save = async () => {
    if (!draft) return cancel();
    setSaving(true);
    try {
      await apiClient.put('/api/config/my-dashboard-layout', { layout: current() });
      setDraft(null);
      setDraftWidgets(null);
      setEditing(false);
      await mutate();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Make the arrangement on screen — panels AND built widgets — a role's default
   * (SUPER_ADMIN only; the route's 403 is the control). Audited and re-auth-gated
   * on the server (`UPDATE_ROLE_CONFIG`); the caller passes the password when the
   * re-auth dialog collected one. The caller's own edit session is left as it is.
   */
  const saveAsRoleDefault = async (role: string, password?: string) => {
    const url = `/api/roles/dashboard-layout/role/${encodeURIComponent(role)}`;
    const body = { layout: current() };
    if (password) await apiClient.putWithReauth(url, body, password);
    else await apiClient.put(url, body);
  };

  /** Add a built widget at the bottom, full width. Edits the draft, like a drag. */
  const addWidget = (w: CustomWidget) => {
    const bottom = items.reduce((max, it) => Math.max(max, it.y + it.h), 0);
    setDraft([...items, { i: widgetItemId(w.id), x: 0, y: bottom, w: 12, h: WIDGET_START_HEIGHT[w.type] }]);
    setDraftWidgets([...widgets, w]);
  };

  const updateWidget = (w: CustomWidget) => {
    if (!draft) setDraft(items);
    setDraftWidgets(widgets.map((x) => (x.id === w.id ? w : x)));
  };

  /** Remove a built widget and the grid item placing it. */
  const removeWidget = (id: string) => {
    setDraft(items.filter((it) => widgetIdOf(it.i) !== id));
    setDraftWidgets(widgets.filter((w) => w.id !== id));
  };

  /** Drop this user's override so their role's default (or the built-in) applies. */
  const reset = async () => {
    setSaving(true);
    try {
      await apiClient.delete('/api/config/my-dashboard-layout');
      setDraft(null);
      setDraftWidgets(null);
      setEditing(false);
      await mutate();
    } finally {
      setSaving(false);
    }
  };

  /**
   * Change one card's chrome.
   *
   * Edits the DRAFT, exactly like a drag: colour and position save together with
   * one button and are discarded together by Cancel. They are one preference
   * about one card, so a half-applied state — a saved colour on a card whose move
   * was cancelled — should not be reachable.
   */
  const setStyle = (key: string, style: PanelStyle | undefined) => {
    setDraft(items.map((it) => {
      if (it.i !== key) return it;
      const { style: _dropped, ...rest } = it;
      return style ? { ...rest, style } : rest;
    }));
  };

  /**
   * Resize one card from the edit panel.
   *
   * The same draft a DRAG writes to, so the two ways of sizing a card cannot
   * disagree and both are discarded by Cancel. Width and height are LAYOUT, not
   * style — which is why this sets w/h rather than going through setStyle.
   */
  const setSize = (key: string, w: number, h: number) => {
    setDraft(items.map((it) => (it.i === key ? { ...it, w, h } : it)));
  };

  return {
    items, widgets, editing, saving, start, cancel, save, reset, setDraft, setStyle, setSize,
    addWidget, updateWidget, removeWidget, saveAsRoleDefault,
    loaded: data !== undefined,
  };
}
