import { useState, useRef, useCallback } from 'react';
import useSWR from 'swr';

interface ReauthState {
  isOpen: boolean;
  password: string;
  error: string;
  isVerifying: boolean;
}

/**
 * Hook that manages re-authentication for any action.
 *
 * Usage:
 *   const reauth = useReauth();
 *
 *   // When user tries to perform an action:
 *   reauth.execute('DELETE_USER', async (password?) => {
 *     if (password) {
 *       await apiClient.deleteWithReauth(`/api/users/${id}`, password);
 *     } else {
 *       await apiClient.delete(`/api/users/${id}`);
 *     }
 *   });
 *
 * Callbacks: exactly ONE of onSuccess / onError / onCancel fires per execute().
 * If you set a loading flag before execute() and clear it only in onSuccess,
 * you MUST handle the cancel path — pass `onCancel` (preferred: a cancel is not
 * an error) or an `onError` that clears the flag. Cancel falls back to onError
 * with `{ error: 'REAUTH_CANCELLED' }` when onCancel is absent, so a caller
 * cannot hang, but onCancel is the honest shape.
 */
export function useReauth() {
  const { data: myActions } = useSWR<{ actions: string[] }>(
    '/api/config/action-reauth/my-actions',
    { revalidateOnMount: true, revalidateOnFocus: false, dedupingInterval: 5000 },
  );

  const [state, setState] = useState<ReauthState>({
    isOpen: false,
    password: '',
    error: '',
    isVerifying: false,
  });

  const pendingAction = useRef<{
    action: string;
    callback: (password?: string) => Promise<any>;
    onSuccess?: () => void;
    onError?: (err: unknown) => void;
    onCancel?: () => void;
    // Set only by executeWithResult — lets confirm/cancel settle the awaited promise.
    resolve?: (value: any) => void;
    reject?: (err: unknown) => void;
  } | null>(null);

  const needsReauth = useCallback(
    (action: string): boolean => {
      return myActions?.actions.includes(action) ?? false;
    },
    [myActions],
  );

  const execute = useCallback(
    async (
      action: string,
      callback: (password?: string) => Promise<void>,
      options?: { onSuccess?: () => void; onError?: (err: unknown) => void; onCancel?: () => void },
    ) => {
      if (needsReauth(action)) {
        pendingAction.current?.reject?.({ error: 'REAUTH_SUPERSEDED' });
        pendingAction.current = {
          action,
          callback,
          onSuccess: options?.onSuccess,
          onError: options?.onError,
          onCancel: options?.onCancel,
        };
        setState({ isOpen: true, password: '', error: '', isVerifying: false });
      } else {
        try {
          await callback();
          options?.onSuccess?.();
        } catch (err: any) {
          // If the backend returns REAUTH_REQUIRED even though the frontend
          // didn't think reauth was needed (e.g. SWR data not loaded yet),
          // show the reauth dialog retroactively instead of swallowing the error.
          if (err?.error === 'REAUTH_REQUIRED') {
            pendingAction.current = {
              action,
              callback,
              onSuccess: options?.onSuccess,
              onError: options?.onError,
              onCancel: options?.onCancel,
            };
            setState({ isOpen: true, password: '', error: '', isVerifying: false });
          } else {
            options?.onError?.(err);
          }
        }
      }
    },
    [needsReauth],
  );

  /**
   * Like `execute`, but RETURNS the callback's result — for flows that need the
   * response value (e.g. a batch POST). When the action needs reauth it opens the
   * password dialog and resolves once the operator confirms (the callback runs
   * with the password inside `confirm`); rejects with `{ error: 'REAUTH_CANCELLED' }`
   * if the operator cancels. Unlike `execute`, it does NOT swallow non-REAUTH
   * errors — they reject so the caller can handle transport failures itself.
   * Existing `execute` callers are unaffected.
   */
  const executeWithResult = useCallback(
    <T,>(action: string, callback: (password?: string) => Promise<T>): Promise<T> => {
      const openDialog = (resolve: (v: T) => void, reject: (e: unknown) => void) => {
        // Supersede any still-pending dialog promise so it can't leak unsettled if
        // a second gated call ever races this shared single-slot ref (no live
        // caller does today, but this keeps the shared primitive safe).
        pendingAction.current?.reject?.({ error: 'REAUTH_SUPERSEDED' });
        pendingAction.current = { action, callback, resolve, reject };
        setState({ isOpen: true, password: '', error: '', isVerifying: false });
      };
      if (needsReauth(action)) {
        return new Promise<T>((resolve, reject) => openDialog(resolve, reject));
      }
      // Not gated per SWR — run inline (Promise.resolve guards a synchronous throw
      // from a non-async callback), fall back to the dialog if the backend still
      // demands reauth (stale SWR), and rethrow any other error so the caller
      // handles transport failures itself.
      return Promise.resolve().then(() => callback()).catch((err: any) => {
        if (err?.error === 'REAUTH_REQUIRED') {
          return new Promise<T>((resolve, reject) => openDialog(resolve, reject));
        }
        throw err;
      });
    },
    [needsReauth],
  );

  const confirm = useCallback(async () => {
    if (!pendingAction.current || !state.password) return;

    setState((s) => ({ ...s, isVerifying: true, error: '' }));
    try {
      const result = await pendingAction.current.callback(state.password);
      pendingAction.current.onSuccess?.();
      pendingAction.current.resolve?.(result);
      setState({ isOpen: false, password: '', error: '', isVerifying: false });
      pendingAction.current = null;
    } catch (err: any) {
      if (err?.error === 'REAUTH_FAILED') {
        setState((s) => ({
          ...s,
          error: 'Incorrect password. Please try again.',
          isVerifying: false,
        }));
      } else if (err?.error === 'REAUTH_REQUIRED') {
        // Password wasn't received — show clearer message
        setState((s) => ({
          ...s,
          error: 'Password is required. Please enter your password.',
          isVerifying: false,
        }));
      } else {
        pendingAction.current?.onError?.(err);
        pendingAction.current?.reject?.(err);
        setState({ isOpen: false, password: '', error: '', isVerifying: false });
        pendingAction.current = null;
      }
    }
  }, [state.password]);

  const cancel = useCallback(() => {
    // Settle any executeWithResult promise so an awaiting caller unblocks.
    pendingAction.current?.reject?.({ error: 'REAUTH_CANCELLED' });

    // ...and notify `execute` callers, which have no promise to await (M85/M64).
    // Pre-fix, cancel settled ONLY the executeWithResult promise, so every
    // execute() caller that clears its submitting flag in onSuccess/onError sat
    // wedged on "Processing…" forever after a cancel — live today on filter-list
    // for the EDIT_FILTER/DELETE_FILTER reauth that SUPERVISORs get.
    //
    // Shape: cancelling is NOT an error, so a caller can pass `onCancel` to
    // unwind cleanly (no error banner). We fall back to `onError` with the same
    // REAUTH_CANCELLED sentinel executeWithResult already rejects with, because
    // a *silent* cancel would leave every existing caller — and every future one
    // that forgets `onCancel` — stuck exactly as before. Callers on the fallback
    // can discriminate via `err.error === 'REAUTH_CANCELLED'`.
    // The fallback carries a `message` because ~45 onError handlers render
    // `err?.message ?? 'Failed'` — with a message-less sentinel every one of them
    // would title a deliberate cancel as "Failed"/"Something went wrong", which is
    // simply untrue. This keeps the text honest even on the fallback path; only
    // the severity styling is off, and `onCancel` removes that too.
    const pending = pendingAction.current;
    if (pending?.onCancel) pending.onCancel();
    else pending?.onError?.({ error: 'REAUTH_CANCELLED', message: 'Cancelled — password confirmation was not completed.' });

    setState({ isOpen: false, password: '', error: '', isVerifying: false });
    pendingAction.current = null;
  }, []);

  const setPassword = useCallback((password: string) => {
    setState((s) => ({ ...s, password }));
  }, []);

  return {
    needsReauth,
    execute,
    executeWithResult,
    confirm,
    cancel,
    setPassword,
    isOpen: state.isOpen,
    password: state.password,
    error: state.error,
    isVerifying: state.isVerifying,
  };
}
