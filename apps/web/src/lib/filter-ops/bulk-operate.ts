import { apiClient } from '@/lib/api-client';

/**
 * `advance-with-checklist` (2026-07-16) — the advance AND its post-stage
 * checklist in ONE server transaction. bulk-operate's transaction is PER ITEM,
 * so sending an `advance` item plus a `submit-checklist` item is two
 * transactions with a gap: an operator who abandons the checklist leaves a
 * committed stage transition whose attestation never happened. Batch submits of
 * a checklist-gated stage MUST use this kind.
 */
export type BulkClientKind = 'advance' | 'start-and-advance' | 'submit-checklist' | 'advance-with-checklist';

export interface BulkClientItem {
  clientOpId: string;
  filterId: string;
  kind: BulkClientKind;
  payload?: any;
  cyclePayload?: any;
  advancePayload?: any;
}

export type BulkClientResult =
  | { clientOpId: string; filterId: string; status: 'ok'; snapshot: any }
  | { clientOpId: string; filterId: string; status: 'failed'; error: { code: string; message: string } };

/**
 * POST a whole batch of cleaning ops in one request. When `password` is given
 * (reauth retry), use the reauth-aware post so the server-side enforceReauth
 * gate is satisfied. Returns the per-item results array.
 */
export async function bulkOperate(
  items: BulkClientItem[],
  password?: string,
): Promise<{ results: BulkClientResult[] }> {
  const body = { items };
  return password
    ? apiClient.postWithReauth('/api/filters/bulk-operate', body, password)
    : apiClient.post('/api/filters/bulk-operate', body);
}
