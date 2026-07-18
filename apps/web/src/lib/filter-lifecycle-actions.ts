// Shared retire/replace network+reauth path for filters. ONE code path so the
// web filter-list panel and the tablet Replace view can never drift (the repo's
// "never separate tablet impl" rule). Callers own their own UI (toasts, cache
// invalidation, panel close) via the onSuccess/onError callbacks; this helper
// owns only the reauth orchestration + the POST, which is the drift-prone part.
import { api } from './api-client';
import type { useReauth } from '@/hooks/use-reauth';

export type RetireReplaceAction = 'retire' | 'replace';

type ReauthInstance = ReturnType<typeof useReauth>;

export interface ReplaceFilterResult {
  success: boolean;
  oldFilterId?: string;
  newFilterId?: string;
  newFilterName?: string;
  // Number of RFID/QR identifiers carried over from the old filter to the new
  // one. The physical tag stays the same; only the filter ID changes.
  identifiersMoved?: number;
}

/**
 * Retire or replace a filter behind a reauth gate.
 *
 * Mirrors the original inline `handlePanelSubmit` logic verbatim:
 *   - reauth action: RETIRE_FILTER / REPLACE_FILTER
 *   - password path uses postWithReauth, non-password path uses post
 *   - the result object is captured inside the callback and handed back via
 *     onSuccess so callers can read newFilterName / identifiersMoved.
 */
export async function retireOrReplaceFilter(
  reauth: ReauthInstance,
  action: RetireReplaceAction,
  filterId: string,
  remarks: string,
  callbacks: {
    onSuccess: (result: ReplaceFilterResult | null) => void;
    onError: (err: unknown) => void;
  },
): Promise<void> {
  const endpoint =
    action === 'retire' ? `/api/filters/${filterId}/retire` : `/api/filters/${filterId}/replace`;
  const reauthAction = action === 'retire' ? 'RETIRE_FILTER' : 'REPLACE_FILTER';
  let result: ReplaceFilterResult | null = null;
  await reauth.execute(
    reauthAction,
    async (password?: string) => {
      const body = { remarks: remarks.trim() };
      if (password) result = await api.postWithReauth<ReplaceFilterResult>(endpoint, body, password);
      else result = await api.post<ReplaceFilterResult>(endpoint, body);
    },
    {
      onSuccess: () => callbacks.onSuccess(result),
      onError: callbacks.onError,
    },
  );
}
