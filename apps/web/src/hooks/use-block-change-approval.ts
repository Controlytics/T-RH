/**
 * Block-change approval handler.
 *
 * Audit 2026-05-04 follow-up to web-routes review C2:
 * `routes/approvals/index.tsx` and `routes/mobile/mobile-wrapper.tsx`
 * carried parallel implementations of the same approve/reject flow that
 * had drifted (the mobile path skipped reauth entirely until commit
 * b8fb038 wrapped both). Extracting the shared logic here so the two
 * call sites can't drift again.
 *
 * Both surfaces require:
 *   - reauth.execute('APPROVE_BLOCK_CHANGE'/'REJECT_BLOCK_CHANGE')
 *   - mandatory `comment` (per the project's "remarks mandatory" rule)
 *   - SWR mutate of the requests list + pending count after success
 *
 * The hook returns a single `process(id, action, comment, opts)` function;
 * the caller wires up the SWR keys + UI state via opts.
 */
import { apiClient, api } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';

interface ProcessOpts {
  /** SWR key(s) to mutate after successful approve/reject. */
  mutateKeys?: string[];
  onSuccess?: () => void;
  onError?: (err: any) => void;
}

export function useBlockChangeApproval() {
  const reauth = useReauth();

  const process = (id: string, action: 'approve' | 'reject', comment: string | undefined, opts: ProcessOpts = {}) => {
    const reauthAction = action === 'approve' ? 'APPROVE_BLOCK_CHANGE' : 'REJECT_BLOCK_CHANGE';
    reauth.execute(
      reauthAction,
      async (password?: string) => {
        const body = { comment: comment || undefined };
        if (password) {
          await api.postWithReauth(`/api/block-change-requests/${id}/${action}`, body, password);
        } else {
          await apiClient.post(`/api/block-change-requests/${id}/${action}`, body);
        }
      },
      {
        onSuccess: () => {
          if (opts.mutateKeys && opts.mutateKeys.length > 0) {
            // Lazy-import swr's mutate so this hook stays tree-shakable in
            // the rare future case the FE swaps data layers.
            import('swr').then(({ mutate }) => {
              for (const key of opts.mutateKeys!) mutate(key);
            }).catch(() => {/* swallow */});
          }
          opts.onSuccess?.();
        },
        onError: opts.onError,
      },
    );
  };

  return {
    process,
    /** Caller renders <ReauthDialog {...reauth} /> at the page root.
     * Returning the reauth state here keeps both call sites consistent. */
    reauth,
  };
}
