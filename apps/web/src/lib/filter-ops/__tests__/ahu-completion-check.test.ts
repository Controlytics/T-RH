import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for the AHU-completion error-handling fix (2026-07-09 QA).
 *
 * Previously both helpers swallowed every error to a "proceed" default, so a
 * transient 500/timeout on the completion-status endpoint silently defeated the
 * INTERLOCK gate (empty ahus read as "all siblings done"). The helpers now
 * distinguish a real failure (`failed: true`) from a legitimate empty result,
 * and log instead of swallowing silently.
 */

vi.mock('@/lib/api-client', () => ({
  apiClient: { post: vi.fn(), get: vi.fn() },
}));

import { checkAhuCompletionBatch, checkAhuHasBothSets } from '../ahu-completion-check';
import { apiClient } from '@/lib/api-client';

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('checkAhuCompletionBatch', () => {
  it('returns failed:false with the AHUs on success', async () => {
    (apiClient.post as any).mockResolvedValue({ ahus: [{ ahuId: 'a', ahuName: 'AHU-1', allAtFinal: false, filters: [] }] });
    const r = await checkAhuCompletionBatch('INTERLOCK', ['f1'], true);
    expect(r.failed).toBe(false);
    expect(r.ahus).toHaveLength(1);
  });

  it('returns failed:true (not a silent empty) and logs when the call errors', async () => {
    (apiClient.post as any).mockRejectedValue(new Error('500'));
    const r = await checkAhuCompletionBatch('INTERLOCK', ['f1'], true);
    expect(r.failed).toBe(true);
    expect(r.ahus).toEqual([]);
    expect(console.error).toHaveBeenCalled();
  });

  it('short-circuits NONE and INTERLOCK-offline as a legitimate (non-failed) no-op', async () => {
    expect(await checkAhuCompletionBatch('NONE', ['f1'], true)).toEqual({ ahus: [], failed: false });
    expect(await checkAhuCompletionBatch('INTERLOCK', ['f1'], false)).toEqual({ ahus: [], failed: false });
    expect(apiClient.post).not.toHaveBeenCalled();
  });
});

describe('checkAhuHasBothSets', () => {
  it('returns true when the AHU spans both sets', async () => {
    (apiClient.post as any).mockResolvedValue({ hasBothSets: true });
    expect(await checkAhuHasBothSets('POPUP', ['f1'], true)).toBe(true);
  });

  it('fails safe to false (→ ALL) and logs on error', async () => {
    (apiClient.post as any).mockRejectedValue(new Error('boom'));
    expect(await checkAhuHasBothSets('POPUP', ['f1'], true)).toBe(false);
    expect(console.error).toHaveBeenCalled();
  });
});
