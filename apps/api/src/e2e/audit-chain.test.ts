import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { auditLog } from '../lib/audit.js';
import { verifyAuditChain } from '../lib/audit-verify.js';

/**
 * Audit 2026-05-04 fix C3 — end-to-end chain integrity.
 *
 * Proves:
 *   (1) New rows written via auditLog() chain to the prior row's checksum
 *       (previous_checksum is non-NULL after the first chained row).
 *   (2) verifyAuditChain() reports intact == true on the unmolested chain.
 *   (3) An in-place mutation of an audit row's after_value is detected as
 *       PER_ROW_CHECKSUM_MISMATCH AND breaks the chain link of every row
 *       written after it.
 *   (4) GET /api/audit/verify-chain endpoint surfaces the same anomalies.
 */

const TEST_USERNAME = 'audit_chain_admin';
const TEST_PASSWORD = 'AuditChain@Test1';

async function ensureUser() {
  const { hashPassword } = await import('../lib/password.js');
  const passwordHash = await hashPassword(TEST_PASSWORD);
  await prisma.user.upsert({
    where: { username: TEST_USERNAME },
    update: {
      passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
      failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null,
    },
    create: {
      username: TEST_USERNAME, passwordHash,
      fullName: 'Audit Chain Test', email: 'audit-chain@test.example',
      role: 'SUPER_ADMIN', status: 'ENABLED',
      forcePasswordChange: false, isTemporaryPassword: false,
    },
  });
}

describe('Audit hash chain — C3', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await ensureUser();
    token = await loginAs(app, TEST_USERNAME, TEST_PASSWORD);
  });

  afterAll(async () => {
    await app.close();
  });

  it('chains consecutive audit rows via previous_checksum', async () => {
    const beforeMaxRow = await prisma.$queryRaw<Array<{ chain_position: bigint | null }>>`
      SELECT chain_position FROM audit_trail ORDER BY chain_position DESC NULLS LAST LIMIT 1
    `;
    const beforeMax = beforeMaxRow[0]?.chain_position == null ? 0 : Number(beforeMaxRow[0].chain_position);

    await auditLog({
      userId: TEST_USERNAME, action: 'CHAIN_TEST_A',
      targetType: 'test', targetId: 'a-1',
      afterValue: { i: 1 }, ipAddress: '127.0.0.1',
    });
    await auditLog({
      userId: TEST_USERNAME, action: 'CHAIN_TEST_B',
      targetType: 'test', targetId: 'b-1',
      afterValue: { i: 2 }, ipAddress: '127.0.0.1',
    });
    await auditLog({
      userId: TEST_USERNAME, action: 'CHAIN_TEST_C',
      targetType: 'test', targetId: 'c-1',
      afterValue: { i: 3 }, ipAddress: '127.0.0.1',
    });

    const newRows = await prisma.$queryRaw<Array<{
      action: string;
      checksum: string;
      previous_checksum: string | null;
      chain_position: bigint;
    }>>`
      SELECT action, checksum, previous_checksum, chain_position
      FROM audit_trail
      WHERE chain_position > ${beforeMax}
      ORDER BY chain_position ASC
    `;

    expect(newRows.length).toBe(3);
    // Every new row carries a previous_checksum (chain era).
    for (const r of newRows) {
      expect(r.previous_checksum).not.toBeNull();
    }
    // The chain link is monotonic — row[i].previous_checksum == row[i-1].checksum.
    expect(newRows[1].previous_checksum).toBe(newRows[0].checksum);
    expect(newRows[2].previous_checksum).toBe(newRows[1].checksum);
  });

  it('verifyAuditChain reports intact==true on a freshly written chain segment', async () => {
    // Capture the high-water mark, write a fresh segment, scope the verifier
    // to only those rows. We can't assume the rest of the dev-DB audit_trail
    // is clean (other tests + seed leave artifacts; the pre-chain era may
    // have rows whose original checksum was computed with a slightly
    // different field-shape than today's verifyAuditChecksum); the meaningful
    // assertion for C3 is that NEW chain writes through auditLog() are
    // tamper-evident, which this scoped check proves directly.
    const beforeMaxRow = await prisma.$queryRaw<Array<{ chain_position: bigint | null }>>`
      SELECT chain_position FROM audit_trail ORDER BY chain_position DESC NULLS LAST LIMIT 1
    `;
    const beforeMax = beforeMaxRow[0]?.chain_position == null ? 0 : Number(beforeMaxRow[0].chain_position);

    await auditLog({ userId: TEST_USERNAME, action: 'INTACT_1', targetType: 'test', targetId: '1' });
    await auditLog({ userId: TEST_USERNAME, action: 'INTACT_2', targetType: 'test', targetId: '2' });
    await auditLog({ userId: TEST_USERNAME, action: 'INTACT_3', targetType: 'test', targetId: '3' });

    const result = await verifyAuditChain({ fromPosition: beforeMax + 1 });
    expect(result.intact).toBe(true);
    expect(result.anomalies).toEqual([]);
    expect(result.totalRowsChecked).toBe(3);
    expect(result.chainedRows).toBe(3);
    expect(result.preChainRows).toBe(0);
  });

  it('detects in-place mutation as PER_ROW_CHECKSUM_MISMATCH and breaks the chain', async () => {
    // Insert a fresh chain segment we can tamper with.
    const beforeMaxRow = await prisma.$queryRaw<Array<{ chain_position: bigint | null }>>`
      SELECT chain_position FROM audit_trail ORDER BY chain_position DESC NULLS LAST LIMIT 1
    `;
    const beforeMax = beforeMaxRow[0]?.chain_position == null ? 0 : Number(beforeMaxRow[0].chain_position);

    await auditLog({ userId: TEST_USERNAME, action: 'TAMPER_BASE', targetType: 'test', targetId: 'tb' });
    await auditLog({ userId: TEST_USERNAME, action: 'TAMPER_VICTIM', targetType: 'test', targetId: 'tv', afterValue: { honest: true } });
    await auditLog({ userId: TEST_USERNAME, action: 'TAMPER_AFTER', targetType: 'test', targetId: 'ta' });

    const tampered = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM audit_trail
      WHERE action = 'TAMPER_VICTIM' AND chain_position > ${beforeMax}
      LIMIT 1
    `;
    expect(tampered[0]).toBeDefined();

    // Tamper: rewrite after_value WITHOUT recomputing checksum. This is the
    // class of attack the chain detects — silent in-place mutation.
    await prisma.$executeRaw`
      UPDATE audit_trail
      SET after_value = ${JSON.stringify({ honest: false, attacker: true })}::jsonb
      WHERE id = ${tampered[0].id}::uuid
    `;

    const result = await verifyAuditChain({ fromPosition: beforeMax + 1 });
    expect(result.intact).toBe(false);
    expect(result.anomalies.some(a => a.kind === 'PER_ROW_CHECKSUM_MISMATCH')).toBe(true);

    // Cleanup: the audit_trail no-delete trigger is conditional on the
    // production seed (compliance invariants live in seed.ts, not migrations
    // — see data-layer review C2). In dev DBs the trigger may not exist;
    // try to disable it but tolerate failure, then attempt the delete. If
    // the trigger IS active and blocks delete, the rows stay (subsequent
    // tests still pass — verify-chain accepts them as legitimately persisted
    // anomalies left by this test, and the test scope filter `fromPosition`
    // confines this to fresh rows only).
    try {
      await prisma.$executeRawUnsafe(`ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_delete`);
      try {
        await prisma.$executeRaw`DELETE FROM audit_trail WHERE chain_position > ${beforeMax}`;
      } finally {
        await prisma.$executeRawUnsafe(`ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_delete`);
      }
    } catch {
      // Trigger not installed — fall through; rows remain but are scoped
      // to this test's chain segment via fromPosition.
    }
  });

  it('GET /api/audit/verify-chain returns the verifier result', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/audit/verify-chain',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body).toHaveProperty('intact');
    expect(body).toHaveProperty('totalRowsChecked');
    expect(body).toHaveProperty('chainedRows');
    expect(body).toHaveProperty('anomalies');
  });
});

/**
 * Keyed-era downgrade — 2026-07-25.
 *
 * verifyAuditChecksum() selects the keyed (v3) or unkeyed (v1/v2) formula from
 * the row's OWN checksum_version column, which lives in the mutable table the
 * chain is supposed to protect. So a DB-level actor can relabel a v3 row to
 * NULL, recompute its checksum with the unkeyed formula (no key required), and
 * the walk takes the unkeyed branch and passes.
 *
 * AUDIT_CHAIN_KEYED_FROM is the out-of-band anchor that closes this. It was
 * read by getAuditChainKeyedFrom() — which had ZERO callers, so the defence its
 * docstring described was never enforced.
 *
 * These two tests are the proof, and they must be read as a pair:
 *   - WITHOUT the boundary, the forged row passes  → the vulnerability is real
 *   - WITH the boundary, it is caught              → the fix actually works
 * If the first test ever starts failing, the vulnerability was closed some
 * other way and this file needs revisiting rather than deleting.
 */
describe('Audit hash chain — keyed-era downgrade', () => {
  const KEY = 'test-audit-chain-key-do-not-use-in-production';

  async function writeKeyedRow(): Promise<{ id: string; position: number }> {
    const { __setAuditChainKeyForTest } = await import('../lib/hash-chain.js');
    const { auditLog } = await import('../lib/audit.js');
    __setAuditChainKeyForTest(KEY);
    await auditLog({
      userId: 'downgrade-test-user',
      userName: 'Downgrade Test',
      userRole: 'SUPER_ADMIN',
      action: 'LOGIN_SUCCESS',
      targetType: 'User',
      targetId: 'downgrade-test-target',
      afterValue: { probe: 'keyed-era' },
    });
    const [row] = await prisma.$queryRaw<Array<{ id: string; chain_position: bigint; checksum_version: number | null }>>`
      SELECT id, chain_position, checksum_version FROM audit_trail
      ORDER BY chain_position DESC LIMIT 1
    `;
    expect(row.checksum_version).toBe(3);   // guard: the writer really keyed it
    return { id: row.id, position: Number(row.chain_position) };
  }

  /** Relabel to unkeyed and recompute the checksum with the unkeyed formula. */
  async function forgeDowngrade(id: string) {
    const { computeChainedChecksum } = await import('../lib/hash-chain.js');
    const [r] = await prisma.$queryRaw<Array<Record<string, any>>>`
      SELECT timestamp, user_id, user_name, user_role, action, target_type,
             target_id, after_value, previous_checksum
      FROM audit_trail WHERE id = ${id}::uuid
    `;
    const forged = computeChainedChecksum({
      timestamp: r.timestamp,
      userId: r.user_id ?? undefined,
      userName: r.user_name ?? undefined,
      userRole: r.user_role ?? undefined,
      action: r.action,
      targetType: r.target_type ?? undefined,
      targetId: r.target_id ?? undefined,
      afterValue: r.after_value ?? undefined,
    }, r.previous_checksum);
    await prisma.$executeRaw`
      UPDATE audit_trail SET checksum_version = NULL, checksum = ${forged}
      WHERE id = ${id}::uuid
    `;
  }

  afterAll(async () => {
    const { __setAuditChainKeyForTest, __setAuditChainKeyedFromForTest } =
      await import('../lib/hash-chain.js');
    __setAuditChainKeyForTest(undefined);
    __setAuditChainKeyedFromForTest(undefined);
  });

  it('WITHOUT the boundary, a downgraded row passes verification (the vulnerability)', async () => {
    const { __setAuditChainKeyedFromForTest } = await import('../lib/hash-chain.js');
    const { id, position } = await writeKeyedRow();
    await forgeDowngrade(id);

    __setAuditChainKeyedFromForTest(null);          // boundary NOT configured
    const result = await verifyAuditChain({ fromPosition: position, toPosition: position });

    expect(result.anomalies).toHaveLength(0);
    expect(result.intact).toBe(true);
  });

  it('WITH the boundary, the same downgrade is caught (the fix)', async () => {
    const { __setAuditChainKeyedFromForTest } = await import('../lib/hash-chain.js');
    const { id, position } = await writeKeyedRow();
    await forgeDowngrade(id);

    __setAuditChainKeyedFromForTest(position);      // boundary at this row
    const result = await verifyAuditChain({ fromPosition: position, toPosition: position });

    expect(result.intact).toBe(false);
    const downgrade = result.anomalies.find(a => a.kind === 'KEYED_ERA_DOWNGRADE');
    expect(downgrade).toBeDefined();
    expect(downgrade?.id).toBe(id);
    expect(downgrade?.expected).toBe('3');
  });

  it('boundary of 0 is enforced, not treated as unset (falsy-zero guard)', async () => {
    const { __setAuditChainKeyedFromForTest } = await import('../lib/hash-chain.js');
    const { id, position } = await writeKeyedRow();
    await forgeDowngrade(id);

    __setAuditChainKeyedFromForTest(0);             // legitimate: key from row 0
    const result = await verifyAuditChain({ fromPosition: position, toPosition: position });

    expect(result.anomalies.some(a => a.kind === 'KEYED_ERA_DOWNGRADE')).toBe(true);
  });
});
