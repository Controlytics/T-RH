import { useState } from 'react';
import useSWR from 'swr';
import { DEFAULT_DASHBOARD_LAYOUT, type DashboardLayout, type LayoutItem, type PanelStyle } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';

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
  const [saving, setSaving] = useState(false);

  const saved = data?.layout ?? DEFAULT_DASHBOARD_LAYOUT;
  // While editing, the draft is the truth. Outside edit mode there is no draft at
  // all, so a background revalidation cannot silently move someone's cards.
  const items = draft ?? saved.items;

  const start = () => {
    setDraft(saved.items);
    setEditing(true);
  };

  const cancel = () => {
    setDraft(null);
    setEditing(false);
  };

  const save = async () => {
    if (!draft) return cancel();
    setSaving(true);
    try {
      await apiClient.put('/api/config/my-dashboard-layout', {
        layout: { version: saved.version, items: draft },
      });
      setDraft(null);
      setEditing(false);
      await mutate();
    } finally {
      setSaving(false);
    }
  };

  /** Drop this user's override so their role's default (or the built-in) applies. */
  const reset = async () => {
    setSaving(true);
    try {
      await apiClient.delete('/api/config/my-dashboard-layout');
      setDraft(null);
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

  return { items, editing, saving, start, cancel, save, reset, setDraft, setStyle, loaded: data !== undefined };
}
