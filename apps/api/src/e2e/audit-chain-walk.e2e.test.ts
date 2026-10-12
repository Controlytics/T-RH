import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs, authPost, ADMIN_PASSWORD } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { auditLog } from '../lib/audit.js';
import { verifyAuditChain } from '../lib/audit-verify.js';
import { __setAuditChainKeyedFromForTest } from '../lib/hash-chain.js';
import { verifyBackupAuditChain } from '../modules/backup/backup.repository.js';

/**
 * Audit 2026-10-12 #3, #4 — ONE chain walk for the live trail and for a
 * backup archive.
 *
 *  #4  A redacted row's columns are compared against the meta row's
 *      HMAC/hash-covered `beforeValue` ({action, timestamp, userId, targetType,
 *      targetId}); a mismatch is REDACTION_MISMATCH.
 *  #3  The restore pre-check runs the SAME walk over the archive, so a keyed-era
 *      downgrade, an unattested redaction or a deletion gap is refused without
 *      `force` — it used to check per-row checksums and links only.
 */
const TAG = `walk${Date.now()}`;

async function maxPosition(): Promise<number> {
  const [r] = await prisma.$queryRaw<Array<{ p: bigint | null }>>`SELECT max(chain_position) AS p FROM audit_trail`;
  return r?.p == null ? 0 : Number(r.p);
}
async function writeRow(action: string, targetId = TAG): Promise<{ id: string; position: number }> {
  await auditLog({ userId: 'admin', userRole: 'SUPER_ADMIN', action, targetType: 'walk-test', targetId, afterValue: { n: 1 } });
  const [row] = await prisma.$queryRaw<Array<{ id: string; chain_position: bigint }>>`
    SELECT id, chain_position FROM audit_trail WHERE action = ${action} ORDER BY chain_position DESC LIMIT 1`;
  return { id: row.id, position: Number(row.chain_position) };
}
async function withTriggersOff(fn: () => Promise<unknown>) {
  await prisma.$executeRawUnsafe('ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_update');
  await prisma.$executeRawUnsafe('ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_delete');
  try { await fn(); } finally {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_update');
    await prisma.$executeRawUnsafe('ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_delete');
  }
}
/** The rows of [from, to] in the shape a backup archive carries them (bigints as strings). */
async function archiveRows(from: number, to: number): Promise<Array<Record<string, unknown>>> {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(
    'SELECT * FROM audit_trail WHERE chain_position BETWEEN $1 AND $2 ORDER BY id ASC', from, to);
  return JSON.parse(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

let app: FastifyInstance;
let token = '';

beforeAll(async () => {
  app = await buildApp();
  token = await loginAs(app);
});
afterAll(async () => {
  __setAuditChainKeyedFromForTest(undefined);
  await app.close();
});

/** A rolled-back audit insert. */
async function rolledBackInsert() {
  await prisma.$transaction(async (tx) => {
    await auditLog({ userId: 'admin', userRole: 'SUPER_ADMIN', action: `${TAG}_ROLLED_BACK`, targetType: 'walk-test', targetId: TAG }, tx);
    throw new Error('roll back');
  }).catch((e: Error) => { if (e.message !== 'roll back') throw e; });
}
async function positionsFrom(from: number): Promise<Array<{ p: number; checksum: string; previous_checksum: string }>> {
  const rows = await prisma.$queryRaw<Array<{ chain_position: bigint; checksum: string; previous_checksum: string }>>`
    SELECT chain_position, checksum, previous_checksum FROM audit_trail WHERE chain_position >= ${from} ORDER BY chain_position`;
  return rows.map((r) => ({ p: Number(r.chain_position), checksum: r.checksum, previous_checksum: r.previous_checksum }));
}

/**
 * Audit 2026-10-12 #5, as decided by the lead (option c): positions come from a
 * TRANSACTIONAL counter (`audit_chain_counter`, migration
 * 20261012120000_audit_chain_counter) bumped under the chain's advisory lock,
 * so a rolled-back audit insert returns its position. Until then
 * chain_position was a BIGSERIAL, which never gives a value back, so every
 * rollback (e.g. auth/session-sweep.ts) left a gap verify-chain reported as an
 * interior deletion. Gaps stay STRICT: a gap now only ever means a deletion.
 */
describe('positions are dense: a rollback returns its position', () => {
  it('a rolled-back audit insert leaves no gap, and verify-chain stays intact', async () => {
    const from = (await maxPosition()) + 1;
    await writeRow(`${TAG}_DENSE_A`);
    await rolledBackInsert();
    await rolledBackInsert();
    await writeRow(`${TAG}_DENSE_B`);
    const rows = await positionsFrom(from);
    expect(rows.map((r) => r.p)).toEqual([from, from + 1]);
    const result = await verifyAuditChain({ fromPosition: from });
    expect(result.anomalies).toEqual([]);
    expect(result.intact).toBe(true);
  });

  it('concurrent writers — with rollbacks among them — produce a dense, correctly linked chain', async () => {
    const from = (await maxPosition()) + 1;
    const N = 8;
    await Promise.all(Array.from({ length: N }, (_, i) => (i % 4 === 3
      ? rolledBackInsert()
      : auditLog({ userId: 'admin', userRole: 'SUPER_ADMIN', action: `${TAG}_CONC`, targetType: 'walk-test', targetId: String(i) }))));
    const rows = await positionsFrom(from);
    const committed = N - N / 4;
    expect(rows.map((r) => r.p)).toEqual(Array.from({ length: committed }, (_, i) => from + i));
    for (let i = 1; i < rows.length; i++) expect(rows[i].previous_checksum).toBe(rows[i - 1].checksum);
    const result = await verifyAuditChain({ fromPosition: from });
    expect(result.anomalies).toEqual([]);
  });
});

describe('chain_position gaps', () => {
  // The case that decides how a gap may be read (2026-10-12): the NEWEST row
  // deleted, then a new row written. The new row links to the last surviving
  // row, so its link is intact — the gap is the ONLY evidence of the deletion.
  // Local data has four such gaps from the 2026-07-25 incident.
  it('a deleted TAIL row followed by a new write is still reported — the gap is the only evidence', async () => {
    const from = (await maxPosition()) + 1;
    await writeRow(`${TAG}_TAIL_A`);
    const victim = await writeRow(`${TAG}_TAIL_B`);
    await withTriggersOff(() => prisma.$executeRaw`DELETE FROM audit_trail WHERE id = ${victim.id}::uuid`);
    await writeRow(`${TAG}_TAIL_C`);
    const result = await verifyAuditChain({ fromPosition: from });
    expect(result.anomalies.map((a) => a.kind)).toEqual(['CHAIN_POSITION_GAP']);
    expect(result.intact).toBe(false);
  });
});

describe('#4 — a redacted row is compared against the meta row that recorded its redaction', () => {
  it('reports REDACTION_MISMATCH when a redacted row\'s columns no longer match its single meta row', async () => {
    const row = await writeRow(`${TAG}_RED_SINGLE`);
    const r = await authPost(app, `/api/audit/${row.id}/redact`, token, { reason: 'walk test redaction' }, ADMIN_PASSWORD);
    expect(r.statusCode).toBe(200);
    const clean = await verifyAuditChain({ fromPosition: row.position, toPosition: row.position });
    expect(clean.anomalies).toEqual([]);

    await withTriggersOff(() => prisma.$executeRaw`UPDATE audit_trail SET target_id = 'someone-else' WHERE id = ${row.id}::uuid`);
    const result = await verifyAuditChain({ fromPosition: row.position, toPosition: row.position });
    const a = result.anomalies.find((x) => x.kind === 'REDACTION_MISMATCH');
    expect(a?.id).toBe(row.id);
    expect(a?.message).toMatch(/targetId/);
  });

  it('does the same through a BULK meta row\'s records[]', async () => {
    const row = await writeRow(`${TAG}_RED_BULK`);
    const r = await authPost(app, '/api/audit/bulk-redact', token, { ids: [row.id], reason: 'walk test bulk redaction' }, ADMIN_PASSWORD);
    expect(r.statusCode).toBe(200);
    expect((await verifyAuditChain({ fromPosition: row.position, toPosition: row.position })).anomalies).toEqual([]);

    await withTriggersOff(() => prisma.$executeRaw`UPDATE audit_trail SET action = 'LOGIN_SUCCESS' WHERE id = ${row.id}::uuid`);
    const result = await verifyAuditChain({ fromPosition: row.position, toPosition: row.position });
    const a = result.anomalies.find((x) => x.kind === 'REDACTION_MISMATCH');
    expect(a?.id).toBe(row.id);
    expect(a?.message).toMatch(/action/);
  });
});

describe('#3 — the restore pre-check is the live verifier, run over the archive', () => {
  it('a genuine slice passes', async () => {
    const from = (await maxPosition()) + 1;
    await writeRow(`${TAG}_ARC_OK_A`);
    await writeRow(`${TAG}_ARC_OK_B`);
    const to = await maxPosition();
    const res = await verifyBackupAuditChain(await archiveRows(from, to));
    expect(res.chainedRows).toBe(2);
  });

  it('refuses an archive carrying a redaction no meta row in the archive attests', async () => {
    const from = (await maxPosition()) + 1;
    await writeRow(`${TAG}_ARC_RED_A`);
    const victim = await writeRow(`${TAG}_ARC_RED_B`);
    await writeRow(`${TAG}_ARC_RED_C`);
    await withTriggersOff(() => prisma.$executeRaw`
      UPDATE audit_trail SET before_value = NULL, after_value = NULL, redacted_at = now(), redacted_by = 'forger', redaction_reason = 'silent'
      WHERE id = ${victim.id}::uuid`);
    const rows = await archiveRows(from, await maxPosition());
    await expect(verifyBackupAuditChain(rows)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/REDACTION_UNATTESTED/) });
  });

  it('refuses a keyed-era downgrade: an unkeyed row at or after AUDIT_CHAIN_KEYED_FROM', async () => {
    const from = (await maxPosition()) + 1;
    await writeRow(`${TAG}_ARC_KEY_A`);
    await writeRow(`${TAG}_ARC_KEY_B`);
    const rows = await archiveRows(from, await maxPosition());
    // This test database writes unkeyed rows (checksum_version NULL); declaring
    // the keyed era to have begun at the first of them makes every one of them
    // a downgrade — exactly the forged-archive shape.
    expect(rows.every((r) => r.checksum_version == null)).toBe(true);
    __setAuditChainKeyedFromForTest(from);
    try {
      await expect(verifyBackupAuditChain(rows)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/KEYED_ERA_DOWNGRADE/) });
    } finally {
      __setAuditChainKeyedFromForTest(undefined);
    }
  });

  it('refuses an archive with a row removed from the middle (gap + broken link)', async () => {
    const from = (await maxPosition()) + 1;
    await writeRow(`${TAG}_ARC_DEL_A`);
    const victim = await writeRow(`${TAG}_ARC_DEL_B`);
    await writeRow(`${TAG}_ARC_DEL_C`);
    const rows = (await archiveRows(from, await maxPosition())).filter((r) => r.id !== victim.id);
    await expect(verifyBackupAuditChain(rows)).rejects.toMatchObject({ statusCode: 400, message: expect.stringMatching(/CHAIN_LINK_MISMATCH|CHAIN_POSITION_GAP/) });
  });
});
