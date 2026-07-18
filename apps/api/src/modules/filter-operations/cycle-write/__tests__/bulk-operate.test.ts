import { describe, it, expect, vi } from 'vitest';
import { bulkOperate, reauthActionsForItems, type BulkOpItem } from '../bulk-operate.js';

// Focused unit test for the REAL orchestration function (Important finding:
// the e2e previously mocked the whole FilterOperationsService with a
// hand-copied duplicate of this loop, so `bulkOperate()` itself was imported
// by nothing). This file imports the actual implementation from
// `../bulk-operate.js` and drives it against a stub service.

const uuid = (n: number) => `00000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

function makeStubService() {
  return {
    advance: vi.fn(),
    startCycle: vi.fn(),
    submitChecklist: vi.fn(),
    advanceWithChecklist: vi.fn(),
  } as any;
}

describe('reauthActionsForItems', () => {
  it('returns [] for an empty list', () => {
    expect(reauthActionsForItems([])).toEqual([]);
  });

  it('returns the de-duplicated union of reauth actions for a mixed batch', () => {
    const items: BulkOpItem[] = [
      { clientOpId: 'a', filterId: uuid(1), kind: 'advance' },
      { clientOpId: 'b', filterId: uuid(2), kind: 'advance' }, // dup kind
      { clientOpId: 'c', filterId: uuid(3), kind: 'start-and-advance' },
      { clientOpId: 'd', filterId: uuid(4), kind: 'submit-checklist' },
    ];
    const actions = reauthActionsForItems(items);
    expect(actions).toHaveLength(3);
    expect(actions).toEqual(
      expect.arrayContaining(['ADVANCE_FILTER_STAGE', 'START_CLEANING_CYCLE', 'SUBMIT_CHECKLIST_WITH_SIGNATURE']),
    );
  });
});

describe('bulkOperate', () => {
  it('dispatches an "advance" item to service.advance with the item payload', async () => {
    const service = makeStubService();
    service.advance.mockResolvedValue({ filterId: uuid(1), currentState: 'WASH_OUT', tapeVersion: 2 });

    const items: BulkOpItem[] = [
      { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
    ];
    const { results } = await bulkOperate(service, {} as any, items);

    expect(service.advance).toHaveBeenCalledTimes(1);
    expect(service.advance).toHaveBeenCalledWith({}, uuid(1), { targetState: 'WASH_OUT', tapeVersion: 1 });
    expect(service.startCycle).not.toHaveBeenCalled();
    expect(service.submitChecklist).not.toHaveBeenCalled();
    expect(results).toEqual([
      { clientOpId: 'a', filterId: uuid(1), status: 'ok', snapshot: { filterId: uuid(1), currentState: 'WASH_OUT', tapeVersion: 2 } },
    ]);
  });

  it('dispatches a "submit-checklist" item to service.submitChecklist with the item payload', async () => {
    const service = makeStubService();
    service.submitChecklist.mockResolvedValue({ filterId: uuid(2), currentState: 'DRY_IN', tapeVersion: 3 });

    const items: BulkOpItem[] = [
      { clientOpId: 'c', filterId: uuid(2), kind: 'submit-checklist', payload: { answers: { q1: 'yes' }, tapeVersion: 1 } },
    ];
    const { results } = await bulkOperate(service, {} as any, items);

    expect(service.submitChecklist).toHaveBeenCalledTimes(1);
    expect(service.submitChecklist).toHaveBeenCalledWith({}, uuid(2), { answers: { q1: 'yes' }, tapeVersion: 1 });
    expect(service.advance).not.toHaveBeenCalled();
    expect(service.startCycle).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: 'ok', snapshot: { filterId: uuid(2), currentState: 'DRY_IN', tapeVersion: 3 } });
  });

  it('"start-and-advance" calls startCycle THEN advance, in order, with the respective payloads', async () => {
    const service = makeStubService();
    const callOrder: string[] = [];
    service.startCycle.mockImplementation(async () => { callOrder.push('startCycle'); return { id: 'cyc-1' }; });
    service.advance.mockImplementation(async () => { callOrder.push('advance'); return { filterId: uuid(3), currentState: 'WASH_IN', tapeVersion: 2 }; });

    const items: BulkOpItem[] = [
      {
        clientOpId: 'b',
        filterId: uuid(3),
        kind: 'start-and-advance',
        cyclePayload: { cleaningReasonKey: 'ROUTINE' },
        advancePayload: { targetState: 'WASH_IN', tapeVersion: 1 },
      },
    ];
    const { results } = await bulkOperate(service, {} as any, items);

    expect(callOrder).toEqual(['startCycle', 'advance']);
    expect(service.startCycle).toHaveBeenCalledWith({}, uuid(3), { cleaningReasonKey: 'ROUTINE' });
    expect(service.advance).toHaveBeenCalledWith({}, uuid(3), { targetState: 'WASH_IN', tapeVersion: 1 });
    expect(results[0]).toMatchObject({
      status: 'ok',
      snapshot: { filterId: uuid(3), currentState: 'WASH_IN', tapeVersion: 2 },
    });
  });

  it('mixed batch dispatches each item to the correct stub method with correct call counts', async () => {
    const service = makeStubService();
    service.advance.mockResolvedValue({ ok: true });
    service.startCycle.mockResolvedValue({ id: 'cyc' });
    service.submitChecklist.mockResolvedValue({ ok: true });

    const items: BulkOpItem[] = [
      { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
      { clientOpId: 'b', filterId: uuid(2), kind: 'start-and-advance', cyclePayload: { cleaningReasonKey: 'ROUTINE' }, advancePayload: { targetState: 'WASH_IN', tapeVersion: 1 } },
      { clientOpId: 'c', filterId: uuid(3), kind: 'submit-checklist', payload: { answers: {}, tapeVersion: 1 } },
    ];
    const { results } = await bulkOperate(service, {} as any, items);

    expect(service.startCycle).toHaveBeenCalledTimes(1);
    expect(service.advance).toHaveBeenCalledTimes(2); // the advance item + start-and-advance's advance
    expect(service.submitChecklist).toHaveBeenCalledTimes(1);
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.status === 'ok')).toBe(true);
  });

  it('partial success: a thrown error with .code fails only that item, other items still succeed', async () => {
    const service = makeStubService();
    service.advance
      .mockImplementationOnce(async () => {
        const err: any = new Error('Tape version stale');
        err.code = 'STALE_TAPE';
        throw err;
      })
      .mockResolvedValueOnce({ filterId: uuid(2), currentState: 'WASH_OUT', tapeVersion: 2 });

    const items: BulkOpItem[] = [
      { clientOpId: 'a', filterId: uuid(1), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
      { clientOpId: 'b', filterId: uuid(2), kind: 'advance', payload: { targetState: 'WASH_OUT', tapeVersion: 1 } },
    ];
    const { results } = await bulkOperate(service, {} as any, items);

    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      clientOpId: 'a',
      filterId: uuid(1),
      status: 'failed',
      error: { code: 'STALE_TAPE', message: 'Tape version stale' },
    });
    expect(results[1]).toEqual({
      clientOpId: 'b',
      filterId: uuid(2),
      status: 'ok',
      snapshot: { filterId: uuid(2), currentState: 'WASH_OUT', tapeVersion: 2 },
    });
  });

  it('a thrown error without .code falls back to OP_FAILED', async () => {
    const service = makeStubService();
    service.submitChecklist.mockRejectedValue(new Error('boom'));

    const items: BulkOpItem[] = [
      { clientOpId: 'x', filterId: uuid(1), kind: 'submit-checklist', payload: { answers: {}, tapeVersion: 1 } },
    ];
    const { results } = await bulkOperate(service, {} as any, items);

    expect(results[0]).toEqual({
      clientOpId: 'x',
      filterId: uuid(1),
      status: 'failed',
      error: { code: 'OP_FAILED', message: 'boom' },
    });
  });
});

/**
 * `advance-with-checklist` in a batch (2026-07-16, step 5).
 *
 * bulkOperate's transaction is PER ITEM, so it cannot make two items atomic.
 * A checklist-gated stage submitted as an `advance` item + a `submit-checklist`
 * item is two transactions with a gap — an operator who abandons the checklist
 * leaves a committed stage transition whose mandatory attestation never
 * happened. The batch must send ONE `advance-with-checklist` item per filter so
 * the atomicity comes from the service method (which owns the single tx).
 */
describe('bulkOperate — advance-with-checklist kind', () => {
  it('requires BOTH reauth actions — it performs both writes', () => {
    const actions = reauthActionsForItems([
      { clientOpId: 'a', filterId: uuid(1), kind: 'advance-with-checklist' },
    ]);
    expect(actions).toHaveLength(2);
    expect(actions).toEqual(
      expect.arrayContaining(['ADVANCE_FILTER_STAGE', 'SUBMIT_CHECKLIST_WITH_SIGNATURE']),
    );
  });

  it('routes the item to the atomic service method, NOT advance + submitChecklist', async () => {
    const service = makeStubService();
    service.advanceWithChecklist.mockResolvedValue({ currentState: 'S2' });

    const items: BulkOpItem[] = [
      {
        clientOpId: 'a',
        filterId: uuid(1),
        kind: 'advance-with-checklist',
        payload: { targetState: 'S2', answers: { q1: 'YES' } },
      },
    ];
    const out = await bulkOperate(service, {} as any, items);

    expect(service.advanceWithChecklist).toHaveBeenCalledTimes(1);
    expect(service.advanceWithChecklist).toHaveBeenCalledWith(
      expect.anything(),
      uuid(1),
      { targetState: 'S2', answers: { q1: 'YES' } },
    );
    // The two-call shape is exactly what re-opens the orphan window.
    expect(service.advance).not.toHaveBeenCalled();
    expect(service.submitChecklist).not.toHaveBeenCalled();
    expect(out.results[0].status).toBe('ok');
  });

  it('keeps partial success — one failed atomic item does not affect the others', async () => {
    const service = makeStubService();
    service.advanceWithChecklist
      .mockRejectedValueOnce(Object.assign(new Error('Checklist already submitted'), { code: 'ALREADY_SUBMITTED' }))
      .mockResolvedValueOnce({ currentState: 'S2' });

    const items: BulkOpItem[] = [
      { clientOpId: 'a', filterId: uuid(1), kind: 'advance-with-checklist', payload: { targetState: 'S2' } },
      { clientOpId: 'b', filterId: uuid(2), kind: 'advance-with-checklist', payload: { targetState: 'S2' } },
    ];
    const out = await bulkOperate(service, {} as any, items);

    expect(out.results[0]).toMatchObject({ status: 'failed', error: { code: 'ALREADY_SUBMITTED' } });
    expect(out.results[1]).toMatchObject({ status: 'ok' });
  });
});
