import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Control needsReauth by mocking the SWR my-actions fetch.
const h = vi.hoisted(() => ({ actions: [] as string[] }));
vi.mock('swr', () => ({ default: () => ({ data: { actions: h.actions } }) }));

import { useReauth } from '../use-reauth';

describe('useReauth.executeWithResult', () => {
  beforeEach(() => { h.actions = []; });

  it('returns the callback result when the action is not reauth-gated', async () => {
    const { result } = renderHook(() => useReauth());
    let out: unknown;
    await act(async () => {
      out = await result.current.executeWithResult('NOT_GATED', async () => ({ results: [1, 2] }));
    });
    expect(out).toEqual({ results: [1, 2] });
  });

  it('re-throws a non-REAUTH error instead of swallowing it (unlike execute)', async () => {
    const { result } = renderHook(() => useReauth());
    await act(async () => {
      await expect(
        result.current.executeWithResult('NOT_GATED', async () => { throw new Error('network down'); }),
      ).rejects.toThrow('network down');
    });
  });

  it('opens the password dialog for a gated action and resolves with the result after confirm', async () => {
    h.actions = ['GATED'];
    const { result } = renderHook(() => useReauth());
    const cb = vi.fn(async (password?: string) => ({ ok: true, password }));

    let promise: Promise<unknown> | undefined;
    act(() => { promise = result.current.executeWithResult('GATED', cb); });

    // Dialog opens; callback has NOT run yet (deferred to confirm).
    await waitFor(() => expect(result.current.isOpen).toBe(true));
    expect(cb).not.toHaveBeenCalled();

    act(() => { result.current.setPassword('secret'); });
    await act(async () => { await result.current.confirm(); });

    await expect(promise!).resolves.toEqual({ ok: true, password: 'secret' });
    expect(cb).toHaveBeenCalledWith('secret');
    expect(result.current.isOpen).toBe(false);
  });

  it('rejects with REAUTH_CANCELLED when the operator cancels the dialog', async () => {
    h.actions = ['GATED'];
    const { result } = renderHook(() => useReauth());

    let promise: Promise<unknown> | undefined;
    act(() => { promise = result.current.executeWithResult('GATED', async () => 'never runs'); });
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    act(() => { result.current.cancel(); });
    await expect(promise!).rejects.toEqual({ error: 'REAUTH_CANCELLED' });
  });

  it('supersedes a still-pending gated promise (rejects it) when a second dialog opens', async () => {
    h.actions = ['GATED'];
    const { result } = renderHook(() => useReauth());

    let first: Promise<unknown> | undefined;
    act(() => { first = result.current.executeWithResult('GATED', async () => 'first'); });
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    // A second gated call takes the single dialog slot — the first must not leak.
    let second: Promise<unknown> | undefined;
    act(() => { second = result.current.executeWithResult('GATED', async (password?: string) => ({ password })); });
    await expect(first!).rejects.toEqual({ error: 'REAUTH_SUPERSEDED' });

    // The second promise still completes normally via confirm.
    act(() => { result.current.setPassword('pw2'); });
    await act(async () => { await result.current.confirm(); });
    await expect(second!).resolves.toEqual({ password: 'pw2' });
  });
});

// M85 + M64 (2026-07-15): cancelling the dialog must unwind `execute` callers.
// Pre-fix `cancel` settled only the executeWithResult promise, so every
// execute() caller that clears its submitting flag in onSuccess/onError stayed
// stuck on "Processing…" forever.
describe('useReauth.execute — cancel notifies the caller', () => {
  beforeEach(() => { h.actions = []; });

  it('calls onError with REAUTH_CANCELLED when the caller passed no onCancel', async () => {
    h.actions = ['GATED'];
    const { result } = renderHook(() => useReauth());
    const onError = vi.fn();
    const onSuccess = vi.fn();
    const cb = vi.fn(async () => {});

    await act(async () => { await result.current.execute('GATED', cb, { onSuccess, onError }); });
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    act(() => { result.current.cancel(); });

    // The wedge fix: the caller IS notified, so its submitting flag can reset.
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'REAUTH_CANCELLED' }),
    );
    expect(onSuccess).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(result.current.isOpen).toBe(false);

    // ~45 onError handlers render `err?.message ?? 'Failed'`. A message-less
    // sentinel would make every one of them title a cancel as "Failed".
    const err = onError.mock.calls[0][0] as { message?: string };
    expect(err.message).toMatch(/cancel/i);
  });

  it('prefers onCancel over onError so a deliberate cancel is not labelled an error', async () => {
    h.actions = ['GATED'];
    const { result } = renderHook(() => useReauth());
    const onError = vi.fn();
    const onCancel = vi.fn();

    await act(async () => {
      await result.current.execute('GATED', async () => {}, { onError, onCancel });
    });
    await waitFor(() => expect(result.current.isOpen).toBe(true));

    act(() => { result.current.cancel(); });

    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('unwinds the retroactive dialog too (backend said REAUTH_REQUIRED despite stale SWR)', async () => {
    // Not gated per SWR, so execute runs inline; the backend rejects with
    // REAUTH_REQUIRED, which opens the dialog late. Cancelling that dialog must
    // still notify the caller.
    h.actions = [];
    const { result } = renderHook(() => useReauth());
    const onError = vi.fn();

    await act(async () => {
      await result.current.execute(
        'NOT_GATED_PER_SWR',
        async (password?: string) => { if (!password) throw { error: 'REAUTH_REQUIRED' }; },
        { onError },
      );
    });
    await waitFor(() => expect(result.current.isOpen).toBe(true));
    onError.mockClear(); // the REAUTH_REQUIRED throw itself must not have notified

    act(() => { result.current.cancel(); });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'REAUTH_CANCELLED' }),
    );
  });

  it('does not fire the previous caller onError when a second execute supersedes it', async () => {
    h.actions = ['GATED'];
    const { result } = renderHook(() => useReauth());
    const firstOnError = vi.fn();
    const secondOnError = vi.fn();

    await act(async () => { await result.current.execute('GATED', async () => {}, { onError: firstOnError }); });
    await waitFor(() => expect(result.current.isOpen).toBe(true));
    await act(async () => { await result.current.execute('GATED', async () => {}, { onError: secondOnError }); });

    // Cancelling now must unwind only the caller that owns the open dialog.
    act(() => { result.current.cancel(); });
    expect(secondOnError).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'REAUTH_CANCELLED' }),
    );
    expect(firstOnError).not.toHaveBeenCalled();
  });
});

