import { describe, it, expect, vi, afterEach } from 'vitest';
import { stageApprovalService } from '../service.js';

// Exercises the REAL bulkDecide orchestration by spying on the real
// approve()/reject() it loops (not a hand-copied duplicate).
describe('stageApprovalService.bulkDecide', () => {
  afterEach(() => vi.restoreAllMocks());
  const ctx = { userId: 'u1' } as any;

  it('loops the real approve() for every id and returns per-item ok results', async () => {
    const approve = vi.spyOn(stageApprovalService, 'approve').mockResolvedValue({ id: 'x', status: 'APPROVED' } as any);
    const out = await stageApprovalService.bulkDecide(ctx, ['a', 'b', 'c'], 'approve', 'looks good');
    expect(approve).toHaveBeenCalledTimes(3);
    expect(approve).toHaveBeenNthCalledWith(1, ctx, 'a', 'looks good');
    expect(out.results).toEqual([
      { id: 'a', status: 'ok' },
      { id: 'b', status: 'ok' },
      { id: 'c', status: 'ok' },
    ]);
  });

  it('partial success — one failed decision does not abort the others', async () => {
    const err = Object.assign(new Error('already decided'), { code: 'ALREADY_DECIDED' });
    const reject = vi.spyOn(stageApprovalService, 'reject')
      .mockResolvedValueOnce({ id: 'a' } as any)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ id: 'c' } as any);
    const out = await stageApprovalService.bulkDecide(ctx, ['a', 'b', 'c'], 'reject', 'wrong stage');
    expect(reject).toHaveBeenCalledTimes(3);
    expect(out.results[0]).toEqual({ id: 'a', status: 'ok' });
    expect(out.results[1]).toEqual({ id: 'b', status: 'failed', error: { code: 'ALREADY_DECIDED', message: 'already decided' } });
    expect(out.results[2]).toEqual({ id: 'c', status: 'ok' });
  });

  it('routes to approve vs reject by action, threading remarks', async () => {
    const approve = vi.spyOn(stageApprovalService, 'approve').mockResolvedValue({} as any);
    const reject = vi.spyOn(stageApprovalService, 'reject').mockResolvedValue({} as any);
    await stageApprovalService.bulkDecide(ctx, ['a'], 'approve');
    await stageApprovalService.bulkDecide(ctx, ['b'], 'reject', 'because');
    expect(approve).toHaveBeenCalledWith(ctx, 'a', undefined);
    expect(reject).toHaveBeenCalledWith(ctx, 'b', 'because');
  });

  it('defaults the error code when the thrown error has none', async () => {
    vi.spyOn(stageApprovalService, 'approve').mockRejectedValue(new Error('boom'));
    const out = await stageApprovalService.bulkDecide(ctx, ['a'], 'approve');
    expect(out.results[0]).toEqual({ id: 'a', status: 'failed', error: { code: 'DECISION_FAILED', message: 'boom' } });
  });
});
