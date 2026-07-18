import { describe, it, expect, afterEach } from 'vitest';
import {
  computeChecksum,
  computeChainedChecksum,
  computeChainedChecksumV2,
  computeChecksumV3,
  computeChainedChecksumV3,
  verifyAuditChecksum,
  __setAuditChainKeyForTest,
} from './hash-chain.js';

describe('computeChecksum (V1 — top-level key sort)', () => {
  it('produces a SHA-256 hex string (64 chars)', () => {
    const checksum = computeChecksum({ key: 'value' });
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const data = { action: 'LOGIN', userId: 'user1', timestamp: '2025-01-01T00:00:00.000Z' };
    const c1 = computeChecksum(data);
    const c2 = computeChecksum(data);
    expect(c1).toBe(c2);
  });

  it('sorts keys for deterministic ordering', () => {
    const c1 = computeChecksum({ b: 2, a: 1 });
    const c2 = computeChecksum({ a: 1, b: 2 });
    expect(c1).toBe(c2);
  });

  it('produces different checksums for different data', () => {
    const c1 = computeChecksum({ action: 'LOGIN' });
    const c2 = computeChecksum({ action: 'LOGOUT' });
    expect(c1).not.toBe(c2);
  });

  it('handles empty object', () => {
    const checksum = computeChecksum({});
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles nested objects', () => {
    const checksum = computeChecksum({ data: { nested: true, value: 42 } });
    expect(checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  it('handles null values in data', () => {
    const c1 = computeChecksum({ key: null });
    const c2 = computeChecksum({ key: 'value' });
    expect(c1).not.toBe(c2);
  });
});

describe('verifyAuditChecksum — pre-chain legacy rows (backward compat)', () => {
  // These tests simulate rows written BEFORE the C3 chain migration.
  // Their stored checksum was computed with computeChecksum(baseFields) — no
  // previousChecksum key. The verifier's legacy fallback path must still accept them.

  it('verifies a pre-chain legacy audit record (no previousChecksum key)', () => {
    const timestamp = '2025-01-15T10:30:00.000Z';
    // Pre-chain formula: computeChecksum without previousChecksum key
    const checksum = computeChecksum({
      timestamp,
      userId: 'admin',
      action: 'LOGIN_SUCCESS',
      targetType: 'user',
      targetId: 'user-123',
      afterValue: { username: 'admin' },
    });

    // Record has no previousChecksum — simulates pre-chain row
    expect(verifyAuditChecksum({
      timestamp,
      userId: 'admin',
      action: 'LOGIN_SUCCESS',
      targetType: 'user',
      targetId: 'user-123',
      afterValue: { username: 'admin' },
      checksum,
    })).toBe(true);
  });

  it('detects tampered action in a pre-chain record', () => {
    const timestamp = '2025-01-15T10:30:00.000Z';
    const checksum = computeChecksum({
      timestamp,
      userId: 'admin',
      action: 'LOGIN_SUCCESS',
      targetType: 'user',
      targetId: 'user-123',
      afterValue: undefined,
    });

    expect(verifyAuditChecksum({
      timestamp,
      userId: 'admin',
      action: 'ACCOUNT_LOCKED', // tampered
      targetType: 'user',
      targetId: 'user-123',
      checksum,
    })).toBe(false);
  });

  it('detects tampered timestamp in a pre-chain record', () => {
    const timestamp = '2025-01-15T10:30:00.000Z';
    const checksum = computeChecksum({
      timestamp,
      userId: 'admin',
      action: 'LOGIN_SUCCESS',
    });

    expect(verifyAuditChecksum({
      timestamp: '2025-01-16T10:30:00.000Z', // tampered
      userId: 'admin',
      action: 'LOGIN_SUCCESS',
      checksum,
    })).toBe(false);
  });

  it('handles Date object in timestamp', () => {
    const date = new Date('2025-01-15T10:30:00.000Z');
    const checksum = computeChecksum({
      timestamp: date.toISOString(),
      action: 'TEST_ACTION',
    });

    expect(verifyAuditChecksum({
      timestamp: date,
      action: 'TEST_ACTION',
      checksum,
    })).toBe(true);
  });

  it('handles null optional fields', () => {
    const checksum = computeChecksum({
      timestamp: '2025-01-15T10:30:00.000Z',
      action: 'TEST',
    });

    expect(verifyAuditChecksum({
      timestamp: '2025-01-15T10:30:00.000Z',
      userId: null,
      action: 'TEST',
      targetType: null,
      targetId: null,
      checksum,
    })).toBe(true);
  });

  it('handles undefined optional fields', () => {
    const checksum = computeChecksum({
      timestamp: '2025-06-01T00:00:00.000Z',
      action: 'DELETE',
    });

    expect(verifyAuditChecksum({
      timestamp: '2025-06-01T00:00:00.000Z',
      action: 'DELETE',
      checksum,
    })).toBe(true);
  });
});

describe('verifyAuditChecksum — V-2 fix: genesis row round-trip', () => {
  // These tests exercise the exact write→verify round-trip for rows written
  // post-C3 with previousChecksum === null (genesis rows). Bug V-2: the verifier
  // was calling computeChecksum(baseFields) — omitting the previousChecksum key —
  // while the writer calls computeChainedChecksum(baseFields, null) which includes
  // {previousChecksum: null} in the hash. This caused genesis rows to always
  // report as "tampered". The fix: verifier now tries computeChainedChecksum(..., null)
  // first (matching the writer) before falling back to the legacy path.

  it('genesis row: writer and verifier produce matching checksums', () => {
    // Simulate exactly what auditLog() does on the write path
    const baseFields = {
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: 'user-abc',
      action: 'FILTER_CREATED',
      targetType: 'filter',
      targetId: 'filter-001',
      afterValue: undefined,
    };
    // Write path: computeChainedChecksum(baseFields, null)
    const storedChecksum = computeChainedChecksum(baseFields, null);

    // Verify path: verifyAuditChecksum with previousChecksum = null
    expect(verifyAuditChecksum({
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: 'user-abc',
      action: 'FILTER_CREATED',
      targetType: 'filter',
      targetId: 'filter-001',
      checksum: storedChecksum,
      previousChecksum: null,
    })).toBe(true);
  });

  it('genesis row with afterValue: writer and verifier match', () => {
    const baseFields = {
      timestamp: '2026-02-15T08:00:00.000Z',
      userId: 'op-123',
      action: 'CYCLE_STARTED',
      targetType: 'cleaning_cycle',
      targetId: 'cycle-999',
      afterValue: { filterIds: ['f1', 'f2'], profileId: 'prof-x' },
    };
    const storedChecksum = computeChainedChecksum(baseFields, null);

    expect(verifyAuditChecksum({
      timestamp: '2026-02-15T08:00:00.000Z',
      userId: 'op-123',
      action: 'CYCLE_STARTED',
      targetType: 'cleaning_cycle',
      targetId: 'cycle-999',
      afterValue: { filterIds: ['f1', 'f2'], profileId: 'prof-x' },
      checksum: storedChecksum,
      previousChecksum: null,
    })).toBe(true);
  });

  it('genesis row: tampered field is still detected', () => {
    const baseFields = {
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: 'user-abc',
      action: 'FILTER_CREATED',
      targetType: 'filter',
      targetId: 'filter-001',
      afterValue: undefined,
    };
    const storedChecksum = computeChainedChecksum(baseFields, null);

    expect(verifyAuditChecksum({
      timestamp: '2026-01-01T00:00:00.000Z',
      userId: 'user-abc',
      action: 'FILTER_DELETED', // tampered
      targetType: 'filter',
      targetId: 'filter-001',
      checksum: storedChecksum,
      previousChecksum: null,
    })).toBe(false);
  });
});

describe('verifyAuditChecksum — V-1 fix: nested afterValue (JSONB key order)', () => {
  // These tests exercise the JSONB-key-order problem: when afterValue is an object
  // with multiple keys, PostgreSQL JSONB may return them in a different order than
  // what was JSON.stringify'd at write time. The V2 recursive canonicalizer sorts
  // nested keys, so write-side and read-side produce the same hash regardless of
  // the key order that arrives from the DB.
  //
  // IMPORTANT: These tests use computeChainedChecksumV2 as the WRITE path.
  // This represents the intended migration state where audit.ts has been updated
  // to call computeChainedChecksumV2 for new writes. The verifier tries V2 first,
  // so new rows (written with V2) verify correctly across JSONB key-order changes.
  //
  // For HISTORICAL rows (still written with V1/computeChainedChecksum), the V1
  // verifier fallback handles flat/simple afterValues correctly. However, historical
  // rows with multi-key nested afterValues where JSONB key order differs from
  // write-time insertion order will continue to report per-row checksum mismatch
  // (this is a pre-existing limitation that cannot be fixed without re-hashing
  // historical data; chain-link verification is unaffected for those rows).

  it('nested afterValue with different key order still verifies (V2 write path, simulates JSONB normalisation)', () => {
    // Write path (V2): afterValue keys in insertion order z, a, m — but V2
    // canonicalises recursively to sorted order, so the stored hash is
    // computed over {a:1, m:2, z:3} regardless of insertion order.
    const writeTimeAfterValue = { z: 3, a: 1, m: 2 };
    const baseFields = {
      timestamp: '2026-03-10T12:00:00.000Z',
      userId: 'op-xyz',
      action: 'STAGE_ADVANCED',
      targetType: 'filter',
      targetId: 'filter-abc',
      afterValue: writeTimeAfterValue,
    };
    const storedChecksum = computeChainedChecksumV2(baseFields, null);

    // Read path: JSONB returns keys in alphabetical order (a, m, z) — different
    // from the write-time insertion order, but V2 verifier sorts recursively and
    // produces the same canonical form as V2 write, so it matches.
    const readBackAfterValue = { a: 1, m: 2, z: 3 }; // same values, JSONB-normalised order
    expect(verifyAuditChecksum({
      timestamp: '2026-03-10T12:00:00.000Z',
      userId: 'op-xyz',
      action: 'STAGE_ADVANCED',
      targetType: 'filter',
      targetId: 'filter-abc',
      afterValue: readBackAfterValue,
      checksum: storedChecksum,
      previousChecksum: null,
    })).toBe(true);
  });

  it('deeply nested afterValue with different key order still verifies (V2 write path)', () => {
    const writeTimeAfterValue = {
      stageId: 'stage-1',
      readings: { tempC: 22, humidity: 65, pressurePa: 101325 },
      operator: { name: 'Jane', role: 'OPERATOR' },
    };
    const baseFields = {
      timestamp: '2026-03-11T09:30:00.000Z',
      userId: 'op-456',
      action: 'CHECKLIST_SUBMITTED',
      targetType: 'checklist',
      targetId: 'cl-789',
      afterValue: writeTimeAfterValue,
    };
    const storedChecksum = computeChainedChecksumV2(baseFields, null);

    // Simulate JSONB returning nested keys in sorted order
    const readBackAfterValue = {
      operator: { name: 'Jane', role: 'OPERATOR' }, // different outer key order
      readings: { humidity: 65, pressurePa: 101325, tempC: 22 }, // different nested order
      stageId: 'stage-1',
    };
    expect(verifyAuditChecksum({
      timestamp: '2026-03-11T09:30:00.000Z',
      userId: 'op-456',
      action: 'CHECKLIST_SUBMITTED',
      targetType: 'checklist',
      targetId: 'cl-789',
      afterValue: readBackAfterValue,
      checksum: storedChecksum,
      previousChecksum: null,
    })).toBe(true);
  });

  it('nested afterValue: actual tampered value is still detected (V2 write path)', () => {
    const baseFields = {
      timestamp: '2026-03-10T12:00:00.000Z',
      userId: 'op-xyz',
      action: 'STAGE_ADVANCED',
      targetType: 'filter',
      targetId: 'filter-abc',
      afterValue: { z: 3, a: 1, m: 2 },
    };
    const storedChecksum = computeChainedChecksumV2(baseFields, null);

    // Tampered: value of 'a' changed from 1 to 99
    expect(verifyAuditChecksum({
      timestamp: '2026-03-10T12:00:00.000Z',
      userId: 'op-xyz',
      action: 'STAGE_ADVANCED',
      targetType: 'filter',
      targetId: 'filter-abc',
      afterValue: { a: 99, m: 2, z: 3 }, // 'a' tampered
      checksum: storedChecksum,
      previousChecksum: null,
    })).toBe(false);
  });

  it('chained row with nested afterValue: V2 write→verify round-trip matches', () => {
    // Simulate a non-genesis chain row with a previousChecksum
    const previousChecksum = 'a'.repeat(64); // synthetic prior row hash
    const baseFields = {
      timestamp: '2026-04-01T10:00:00.000Z',
      userId: 'admin-1',
      action: 'FILTER_RETIRED',
      targetType: 'filter',
      targetId: 'filter-zzz',
      afterValue: { retiredBy: 'admin-1', reason: 'End of life', metadata: { code: 42, tags: ['a', 'b'] } },
    };
    const storedChecksum = computeChainedChecksumV2(baseFields, previousChecksum);

    // Read back with JSONB-normalised key order in afterValue
    const readBackAfterValue = {
      metadata: { code: 42, tags: ['a', 'b'] }, // outer key reordered
      reason: 'End of life',
      retiredBy: 'admin-1',
    };
    expect(verifyAuditChecksum({
      timestamp: '2026-04-01T10:00:00.000Z',
      userId: 'admin-1',
      action: 'FILTER_RETIRED',
      targetType: 'filter',
      targetId: 'filter-zzz',
      afterValue: readBackAfterValue,
      checksum: storedChecksum,
      previousChecksum,
    })).toBe(true);
  });
});

describe('verifyAuditChecksum — chained rows (non-genesis)', () => {
  it('verifies a valid chained row', () => {
    const previousChecksum = 'b'.repeat(64);
    const baseFields = {
      timestamp: '2026-05-01T00:00:00.000Z',
      userId: 'user-1',
      action: 'LOGIN_SUCCESS',
      targetType: undefined,
      targetId: undefined,
      afterValue: undefined,
    };
    const storedChecksum = computeChainedChecksum(baseFields, previousChecksum);

    expect(verifyAuditChecksum({
      timestamp: '2026-05-01T00:00:00.000Z',
      userId: 'user-1',
      action: 'LOGIN_SUCCESS',
      checksum: storedChecksum,
      previousChecksum,
    })).toBe(true);
  });

  it('detects tampered field in a chained row', () => {
    const previousChecksum = 'c'.repeat(64);
    const baseFields = {
      timestamp: '2026-05-01T00:00:00.000Z',
      userId: 'user-2',
      action: 'LOGOUT',
      targetType: undefined,
      targetId: undefined,
      afterValue: undefined,
    };
    const storedChecksum = computeChainedChecksum(baseFields, previousChecksum);

    expect(verifyAuditChecksum({
      timestamp: '2026-05-01T00:00:00.000Z',
      userId: 'user-2',
      action: 'LOGIN_SUCCESS', // tampered
      checksum: storedChecksum,
      previousChecksum,
    })).toBe(false);
  });

  it('detects tampered previousChecksum', () => {
    const previousChecksum = 'd'.repeat(64);
    const baseFields = {
      timestamp: '2026-05-01T00:00:00.000Z',
      userId: 'user-3',
      action: 'LOGOUT',
      targetType: undefined,
      targetId: undefined,
      afterValue: undefined,
    };
    const storedChecksum = computeChainedChecksum(baseFields, previousChecksum);

    // Provide a different previousChecksum at verify time — should fail
    expect(verifyAuditChecksum({
      timestamp: '2026-05-01T00:00:00.000Z',
      userId: 'user-3',
      action: 'LOGOUT',
      checksum: storedChecksum,
      previousChecksum: 'e'.repeat(64), // tampered chain link
    })).toBe(false);
  });
});

/**
 * This block used to assert `always returns true for redacted rows`, justified
 * by "the chain walker detects mutations via the next row's previousChecksum".
 * That is false, and the test locked the hole in: the next row's link points at
 * this row's STORED checksum, which an attacker never touches. Rewriting
 * before/after_value on a redacted row left every link intact — row valid, chain
 * valid, forgery served. A redacted row's payload is guaranteed NULL (the redact
 * handler sets `before_value = NULL, after_value = NULL`), so that is what we
 * assert instead.
 */
describe('verifyAuditChecksum — redacted rows', () => {
  const redacted = (extra: Record<string, unknown> = {}) => ({
    timestamp: '2025-01-01T00:00:00.000Z',
    action: 'SOME_ACTION',
    checksum: 'cannot-be-recomputed-after-redaction',
    redactedAt: new Date(),
    ...extra,
  });

  it('accepts a properly redacted row (both payloads NULL)', () => {
    expect(verifyAuditChecksum(redacted({ beforeValue: null, afterValue: null }))).toBe(true);
  });

  it('accepts a redacted row whose payloads are absent rather than null', () => {
    expect(verifyAuditChecksum(redacted())).toBe(true);
  });

  // ── the tamper case the old test allowed through ──
  it('REJECTS a redacted row whose afterValue was re-populated', () => {
    expect(verifyAuditChecksum(redacted({ beforeValue: null, afterValue: { forged: true } }))).toBe(false);
  });

  it('REJECTS a redacted row whose beforeValue was re-populated', () => {
    expect(verifyAuditChecksum(redacted({ beforeValue: { forged: true }, afterValue: null }))).toBe(false);
  });

  it('REJECTS re-population even when the stored checksum is left untouched', () => {
    // The whole point: the attacker leaves checksum + previous_checksum alone,
    // so every chain link still matches. Only this check catches it.
    const row = redacted({ beforeValue: { role: 'OPERATOR' }, afterValue: { role: 'SUPER_ADMIN' }, previousChecksum: 'abc123' });
    expect(verifyAuditChecksum(row)).toBe(false);
  });
});

describe('V3 keyed checksum (HMAC-SHA256)', () => {
  const KEY = 'super-secret-audit-chain-key';
  const row = {
    timestamp: '2025-01-01T00:00:00.000Z',
    userId: 'u1',
    userName: 'User One',
    userRole: 'ADMIN',
    action: 'PASSWORD_RESET',
    targetType: 'user',
    targetId: 't1',
    beforeValue: undefined,
    afterValue: { status: 'ENABLED' },
    reason: undefined,
    ipAddress: '127.0.0.1',
    userAgent: 'test',
    sessionId: 's1',
    signatureMeaning: 'Administrator reset user password',
  };
  const fields = {
    timestamp: row.timestamp, userId: row.userId, userName: row.userName, userRole: row.userRole,
    action: row.action, targetType: row.targetType, targetId: row.targetId,
    beforeValue: undefined, afterValue: row.afterValue, reason: undefined,
    ipAddress: row.ipAddress, userAgent: row.userAgent, sessionId: row.sessionId,
    signatureMeaning: row.signatureMeaning,
  };

  afterEach(() => __setAuditChainKeyForTest(undefined)); // reset the cached key

  it('produces a 64-char hex HMAC that differs from the unkeyed SHA-256', () => {
    const hmac = computeChecksumV3(fields, KEY);
    expect(hmac).toMatch(/^[a-f0-9]{64}$/);
    expect(hmac).not.toBe(computeChecksum(fields));
  });

  it('depends on the key — a different key yields a different checksum', () => {
    expect(computeChecksumV3(fields, KEY)).not.toBe(computeChecksumV3(fields, 'other-key'));
  });

  it('verifies a v3 row when the correct key is configured', () => {
    __setAuditChainKeyForTest(KEY);
    const checksum = computeChainedChecksumV3(fields, null, KEY);
    expect(verifyAuditChecksum({ ...row, checksum, previousChecksum: null, checksumVersion: 3 })).toBe(true);
  });

  it('REJECTS a v3 row when no key is configured (fail loud, not silently valid)', () => {
    const checksum = computeChainedChecksumV3(fields, null, KEY);
    __setAuditChainKeyForTest(null); // key unset
    expect(verifyAuditChecksum({ ...row, checksum, previousChecksum: null, checksumVersion: 3 })).toBe(false);
  });

  it('REJECTS a v3 row verified under the wrong key', () => {
    const checksum = computeChainedChecksumV3(fields, null, KEY);
    __setAuditChainKeyForTest('WRONG-KEY');
    expect(verifyAuditChecksum({ ...row, checksum, previousChecksum: null, checksumVersion: 3 })).toBe(false);
  });

  it('REJECTS a v3 row whose field was tampered', () => {
    __setAuditChainKeyForTest(KEY);
    const checksum = computeChainedChecksumV3(fields, null, KEY);
    expect(verifyAuditChecksum({ ...row, action: 'TAMPERED', checksum, previousChecksum: null, checksumVersion: 3 })).toBe(false);
  });

  it('does NOT accept an unkeyed SHA-256 checksum for a v3 row (no downgrade)', () => {
    __setAuditChainKeyForTest(KEY);
    // An attacker recomputes with the unkeyed formula but stamps version 3.
    const unkeyed = computeChainedChecksumV2(fields, null);
    expect(verifyAuditChecksum({ ...row, checksum: unkeyed, previousChecksum: null, checksumVersion: 3 })).toBe(false);
  });

  it('still verifies legacy (unkeyed) rows even when a key is configured', () => {
    __setAuditChainKeyForTest(KEY);
    const legacy = computeChainedChecksumV2(fields, null);
    // checksumVersion null/absent → legacy path, no key required.
    expect(verifyAuditChecksum({ ...row, checksum: legacy, previousChecksum: null, checksumVersion: null })).toBe(true);
  });

  it('verifies a chained (non-genesis) v3 row', () => {
    __setAuditChainKeyForTest(KEY);
    const prev = 'a'.repeat(64);
    const checksum = computeChainedChecksumV3(fields, prev, KEY);
    expect(verifyAuditChecksum({ ...row, checksum, previousChecksum: prev, checksumVersion: 3 })).toBe(true);
  });
});
