import { describe, it, expect, beforeEach, vi } from 'vitest';

// Audit 2026-05-04 fix C3: rewrote auditLog() to use a Postgres advisory
// lock + raw SQL inside $transaction so the row chains to its predecessor.
// Mocks reflect the new shape — tx.$queryRaw (prior-row read, and since
// 2026-10-12 the chain_position allocation from audit_chain_counter) and
// tx.$executeRaw (lock + insert).

const { mockTxQueryRaw, mockTxExecuteRaw, mockTransaction, mockComputeChainedChecksum, mockComputeChecksum } = vi.hoisted(() => {
  return {
    mockTxQueryRaw: vi.fn(),
    mockTxExecuteRaw: vi.fn(),
    mockTransaction: vi.fn(),
    mockComputeChainedChecksum: vi.fn(),
    mockComputeChecksum: vi.fn(),
  };
});

vi.mock('./prisma.js', () => ({
  prisma: {
    $transaction: mockTransaction,
  },
}));

vi.mock('./hash-chain.js', () => ({
  // V-1 write-path migration (audit 2026-05-29): audit.ts now calls V2.
  // The mock variable name is unchanged for assertion-call-site stability.
  computeChainedChecksumV2: mockComputeChainedChecksum,
  computeChecksum: mockComputeChecksum,
  computeChainedChecksumV3: vi.fn(() => 'hmac-chained'),
  // Default: no AUDIT_CHAIN_KEY → audit.ts stays on the V2 (unkeyed) path, so
  // these tests exercise the unchanged legacy write. A dedicated case below
  // overrides this to assert the keyed (v3) path.
  getAuditChainKey: vi.fn(() => null),
}));

import { auditLog } from './audit.js';

/** The prior chain row the next read returns, and the position the counter hands out. */
let priorRows: Array<{ checksum: string }> = [];
let counterRows: Array<{ position: bigint }> = [{ position: 42n }];
const sqlOf = (args: unknown[]) => (Array.isArray(args[0]) ? (args[0] as string[]).join('?') : String(args[0]));

beforeEach(() => {
  vi.clearAllMocks();
  mockComputeChainedChecksum.mockReturnValue('sha256-chained');
  mockComputeChecksum.mockReturnValue('sha256-perrow');
  // Default: no prior chain row → previousChecksum stays null.
  priorRows = [];
  counterRows = [{ position: 42n }];
  mockTxQueryRaw.mockImplementation(async (...args: unknown[]) =>
    (sqlOf(args).includes('audit_chain_counter') ? counterRows : priorRows));
  mockTxExecuteRaw.mockResolvedValue(1);
  // Wire $transaction(callback) → callback({ $queryRaw, $executeRaw })
  mockTransaction.mockImplementation(async (cb: (tx: any) => Promise<any>) =>
    cb({ $queryRaw: mockTxQueryRaw, $executeRaw: mockTxExecuteRaw }));
});

describe('auditLog — C3 chain', () => {
  it('writes a genesis row when audit_trail is empty (previousChecksum=null)', async () => {
    priorRows = []; // prior chain row read returns nothing
    await auditLog({
      userId: 'admin',
      userRole: 'ADMIN',
      action: 'USER_CREATED',
      targetType: 'user',
      targetId: 'u1',
      afterValue: { username: 'newuser' },
      ipAddress: '127.0.0.1',
    });

    expect(mockTransaction).toHaveBeenCalledTimes(1);
    // executeRaw is called twice (lock + insert); queryRaw twice (select
    // prior, allocate the position from the counter).
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(2);
    expect(mockTxQueryRaw).toHaveBeenCalledTimes(2);
    expect(mockComputeChainedChecksum).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'admin',
        action: 'USER_CREATED',
        targetType: 'user',
        targetId: 'u1',
      }),
      null,
    );
  });

  it('chains to the prior checksum when one exists', async () => {
    priorRows = [{ checksum: 'prior-sha-abc' }];
    await auditLog({
      userId: 'test-user',
      action: 'LOGOUT',
      targetType: 'session',
      targetId: 's1',
    });
    expect(mockComputeChainedChecksum).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGOUT' }),
      'prior-sha-abc',
    );
  });

  it('handles entries without afterValue', async () => {
    await auditLog({ userId: 'test-user', action: 'LOGOUT', targetType: 'session', targetId: 's1' });
    expect(mockComputeChainedChecksum).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'LOGOUT',
        afterValue: undefined,
      }),
      null,
    );
  });

  it('deep clones afterValue before stringifying for insert', async () => {
    const afterValue = { nested: { key: 'value' } };
    await auditLog({ userId: 'test-user', action: 'TEST', afterValue });
    const checksumCall = mockComputeChainedChecksum.mock.calls[0][0] as Record<string, unknown>;
    // The cloned value reaches the checksum input; original object reference
    // is not used (no mutation aliasing).
    expect(checksumCall.afterValue).toEqual(afterValue);
    expect(checksumCall.afterValue).not.toBe(afterValue);
  });

  it('passes signatureMeaning through to the insert', async () => {
    await auditLog({
      userId: 'test-user',
      action: 'PASSWORD_CHANGED',
      signatureMeaning: 'User changed password',
    });
    // signatureMeaning is in the executeRaw template; verify both calls
    // (lock + insert) ran, then check the insert's bind values include the
    // signatureMeaning. Tagged-template arguments come through as a Sql
    // template object; vitest captures them as `[strings, ...values]`.
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(2);
    // The 2nd executeRaw call is the INSERT — its values array should
    // contain the signatureMeaning string.
    const insertCall = mockTxExecuteRaw.mock.calls[1];
    const valuesContain = JSON.stringify(insertCall, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)).includes('User changed password');
    expect(valuesContain).toBe(true);
  });

  // Audit 2026-10-12 #5: the position is allocated from the transactional
  // counter, under the lock, and written explicitly — never the BIGSERIAL
  // default, which a rollback cannot return.
  it('writes the position the counter allocated, after taking the lock', async () => {
    counterRows = [{ position: 7001n }];
    await auditLog({ userId: 'test-user', action: 'TEST' });
    const order = [...mockTxExecuteRaw.mock.invocationCallOrder, ...mockTxQueryRaw.mock.invocationCallOrder].sort((a, b) => a - b);
    expect(mockTxExecuteRaw.mock.invocationCallOrder[0]).toBe(order[0]); // the lock first
    const insert = mockTxExecuteRaw.mock.calls[1];
    expect(sqlOf(insert)).toContain('chain_position');
    expect(insert.slice(1)).toContain(7001n);
  });

  it('refuses to write when the counter row is missing — never falls back to the sequence', async () => {
    counterRows = [];
    await expect(auditLog({ userId: 'test-user', action: 'TEST' })).rejects.toThrow(/audit_chain_counter/);
    expect(mockTxExecuteRaw).toHaveBeenCalledTimes(1); // the lock only, no insert
  });
});
