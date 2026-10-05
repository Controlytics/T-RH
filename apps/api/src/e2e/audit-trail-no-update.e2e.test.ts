import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp, loginAs } from './test-helper.js';
import { prisma } from '../lib/prisma.js';
import { auditLog } from '../lib/audit.js';
import { verifyAuditChain } from '../lib/audit-verify.js';

/**
 * `audit_trail_no_update` (migration 20261005120000; audit 2026-10-03, DATA-6)
 * and the verifier's redaction cross-check.
 *
 * Until these, a DB actor could `UPDATE audit_trail SET before_value = NULL,
 * after_value = NULL, redacted_at = now()` on any row: no meta row, chain
 * intact, and the per-row check short-circuits a redacted row to "payloads
 * NULL", so it passed as a legitimate redaction. The trigger permits exactly
 * ONE transition — the one the redact routes make — and refuses every other
 * UPDATE; the verifier then reports a redacted row that no meta row names.
 *
 * Each refusal below is a MUTATION CHECK of the trigger's clause list: an
 * UPDATE of after_value alone (the attack), a redaction that also changes
 * another column, an un-redaction, a second redaction, a redaction with the
 * payloads left in place, one with no redactor.
 */
const USERNAME = 'audit_noupdate_admin';
const PASSWORD = 'AuditNoUpdate@Test1';
const TRIGGER_MSG = /audit_trail rows are immutable/;

async function writeRow(action: string): Promise<{ id: string; position: number }> {
  await auditLog({ userId: USERNAME, userRole: 'SUPER_ADMIN', action, targetType: 'test', targetId: 'nu', afterValue: { secret: 42 } });
  const [row] = await prisma.$queryRaw<Array<{ id: string; chain_position: bigint }>>`
    SELECT id, chain_position FROM audit_trail WHERE action = ${action} ORDER BY chain_position DESC LIMIT 1`;
  return { id: row.id, position: Number(row.chain_position) };
}

/** The exact UPDATE the redact route makes. */
const redactSql = (id: string, reason = 'test redaction') => prisma.$executeRaw`
  UPDATE audit_trail
  SET before_value = NULL, after_value = NULL,
      redacted_at = now(), redacted_by = 'trigger-test', redaction_reason = ${reason}
  WHERE id = ${id}::uuid`;

describe('audit_trail_no_update trigger', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    const { hashPassword } = await import('../lib/password.js');
    const passwordHash = await hashPassword(PASSWORD);
    await prisma.user.upsert({
      where: { username: USERNAME },
      update: { passwordHash, role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false, failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null },
      create: { username: USERNAME, passwordHash, fullName: 'No Update Test', email: 'audit-noupdate@test.example', role: 'SUPER_ADMIN', status: 'ENABLED', forcePasswordChange: false, isTemporaryPassword: false },
    });
    token = await loginAs(app, USERNAME, PASSWORD);
  });

  afterAll(async () => { await app.close(); });

  it('is installed on audit_trail', async () => {
    const rows = await prisma.$queryRaw<Array<{ tgname: string; tgenabled: string }>>`
      SELECT tgname, tgenabled::text FROM pg_trigger WHERE tgrelid = 'audit_trail'::regclass AND tgname = 'audit_trail_no_update'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].tgenabled).not.toBe('D');
  });

  it('refuses rewriting after_value on a row that is not being redacted — the attack', async () => {
    const { id } = await writeRow('NU_PAYLOAD_EDIT');
    await expect(prisma.$executeRaw`
      UPDATE audit_trail SET after_value = ${JSON.stringify({ secret: 0 })}::jsonb WHERE id = ${id}::uuid`,
    ).rejects.toThrow(TRIGGER_MSG);
    const [row] = await prisma.$queryRaw<Array<{ after_value: { secret: number } }>>`SELECT after_value FROM audit_trail WHERE id = ${id}::uuid`;
    expect(row.after_value.secret).toBe(42);
  });

  it('refuses touching the checksum, the chain link, the action or the user', async () => {
    const { id } = await writeRow('NU_COLUMN_EDIT');
    await expect(prisma.$executeRaw`UPDATE audit_trail SET checksum = repeat('0', 64) WHERE id = ${id}::uuid`).rejects.toThrow(TRIGGER_MSG);
    await expect(prisma.$executeRaw`UPDATE audit_trail SET previous_checksum = NULL WHERE id = ${id}::uuid`).rejects.toThrow(TRIGGER_MSG);
    await expect(prisma.$executeRaw`UPDATE audit_trail SET action = 'LOGIN_SUCCESS' WHERE id = ${id}::uuid`).rejects.toThrow(TRIGGER_MSG);
    await expect(prisma.$executeRaw`UPDATE audit_trail SET user_id = 'somebody' WHERE id = ${id}::uuid`).rejects.toThrow(TRIGGER_MSG);
    await expect(prisma.$executeRaw`UPDATE audit_trail SET checksum_version = NULL WHERE id = ${id}::uuid`).rejects.toThrow(TRIGGER_MSG);
  });

  it('permits the one redaction transition, and only once', async () => {
    const { id } = await writeRow('NU_REDACT_OK');
    await expect(redactSql(id)).resolves.toBe(1);
    const [row] = await prisma.$queryRaw<Array<{ after_value: unknown; redacted_by: string }>>`SELECT after_value, redacted_by FROM audit_trail WHERE id = ${id}::uuid`;
    expect(row.after_value).toBeNull();
    expect(row.redacted_by).toBe('trigger-test');
    // A second redaction (a different reason / redactor) is refused — the
    // first redactor's name and reason are the record.
    await expect(redactSql(id, 'overwrite the reason')).rejects.toThrow(TRIGGER_MSG);
    // And un-redacting is refused.
    await expect(prisma.$executeRaw`
      UPDATE audit_trail SET redacted_at = NULL, redacted_by = NULL, redaction_reason = NULL WHERE id = ${id}::uuid`,
    ).rejects.toThrow(TRIGGER_MSG);
  });

  it('refuses a redaction that leaves a payload in place, names no redactor, or changes another column', async () => {
    const { id } = await writeRow('NU_REDACT_BAD');
    await expect(prisma.$executeRaw`
      UPDATE audit_trail SET before_value = NULL, redacted_at = now(), redacted_by = 'x', redaction_reason = 'r' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(TRIGGER_MSG);
    await expect(prisma.$executeRaw`
      UPDATE audit_trail SET before_value = NULL, after_value = NULL, redacted_at = now(), redaction_reason = 'r' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(TRIGGER_MSG);
    await expect(prisma.$executeRaw`
      UPDATE audit_trail SET before_value = NULL, after_value = NULL, redacted_at = now(), redacted_by = 'x', redaction_reason = 'r',
          reason = 'smuggled' WHERE id = ${id}::uuid`,
    ).rejects.toThrow(TRIGGER_MSG);
    const [row] = await prisma.$queryRaw<Array<{ redacted_at: Date | null; after_value: unknown }>>`SELECT redacted_at, after_value FROM audit_trail WHERE id = ${id}::uuid`;
    expect(row.redacted_at).toBeNull();
    expect(row.after_value).toEqual({ secret: 42 });
  });

  it('the redact endpoint still works through the trigger, and verify-chain stays intact', async () => {
    const { id, position } = await writeRow('NU_ROUTE_REDACT');
    const res = await app.inject({
      method: 'POST', url: `/api/audit/${id}/redact`,
      headers: { authorization: `Bearer ${token}`, 'x-reauth-password': PASSWORD },
      payload: { reason: 'contains a personal note' },
    });
    expect(res.statusCode).toBe(200);
    const result = await verifyAuditChain({ fromPosition: position });
    expect(result.anomalies.filter((a) => a.id === id)).toEqual([]);
    const meta = await prisma.auditTrail.findFirst({ where: { action: 'AUDIT_RECORD_REDACTED', targetId: id } });
    expect(meta).toBeTruthy();
  });
});

describe('verify-chain cross-checks every redacted row against its meta row', () => {
  // The trigger cannot be the whole control: the threat is an actor who can
  // disable it. Simulate that, redact with no meta row, and the verifier must
  // say so.
  async function withTriggerDisabled(fn: () => Promise<void>) {
    await prisma.$executeRawUnsafe('ALTER TABLE audit_trail DISABLE TRIGGER audit_trail_no_update');
    try { await fn(); } finally {
      await prisma.$executeRawUnsafe('ALTER TABLE audit_trail ENABLE TRIGGER audit_trail_no_update');
    }
  }

  it('reports REDACTION_UNATTESTED for a redaction no meta row names, and clears it once one does', async () => {
    const { id, position } = await writeRow('NU_UNATTESTED');
    await withTriggerDisabled(async () => { await redactSql(id, 'silent'); });

    const before = await verifyAuditChain({ fromPosition: position, toPosition: position });
    expect(before.intact).toBe(false);
    expect(before.anomalies.map((a) => a.kind)).toContain('REDACTION_UNATTESTED');
    expect(before.anomalies.find((a) => a.kind === 'REDACTION_UNATTESTED')?.id).toBe(id);

    // A meta row naming it — what the route writes in the same transaction —
    // is the attestation, even though it sits outside the verified window.
    await auditLog({
      userId: USERNAME, userRole: 'SUPER_ADMIN', action: 'AUDIT_RECORD_REDACTED',
      targetType: 'audit_trail', targetId: id, reason: 'now attested',
    });
    const after = await verifyAuditChain({ fromPosition: position, toPosition: position });
    expect(after.anomalies.filter((a) => a.kind === 'REDACTION_UNATTESTED')).toEqual([]);
  });

  it('accepts a bulk meta row naming the id in before_value.records', async () => {
    const { id, position } = await writeRow('NU_BULK_ATTESTED');
    await withTriggerDisabled(async () => { await redactSql(id, 'bulk'); });
    await auditLog({
      userId: USERNAME, userRole: 'SUPER_ADMIN', action: 'AUDIT_RECORDS_BULK_REDACTED',
      targetType: 'audit_trail', reason: 'bulk', beforeValue: { recordCount: 1, records: [{ id, action: 'NU_BULK_ATTESTED' }] },
    });
    const result = await verifyAuditChain({ fromPosition: position, toPosition: position });
    expect(result.anomalies.filter((a) => a.kind === 'REDACTION_UNATTESTED')).toEqual([]);
  });

  it('a meta row that sits BEFORE the row it names does not attest it', async () => {
    // The route writes the meta row AFTER the UPDATE in one transaction, so a
    // genuine attestation is always later in the chain. Forge the other order
    // with the trigger off: a meta row first, the victim after it, the victim
    // redacted, the meta row re-pointed at it.
    const placeholder = `placeholder-${Date.now()}`;
    await auditLog({ userId: USERNAME, userRole: 'SUPER_ADMIN', action: 'AUDIT_RECORD_REDACTED', targetType: 'audit_trail', targetId: placeholder, reason: 'early' });
    const victim = await writeRow('NU_EARLY_META_VICTIM');
    await withTriggerDisabled(async () => {
      await redactSql(victim.id, 'late');
      await prisma.$executeRaw`UPDATE audit_trail SET target_id = ${victim.id} WHERE action = 'AUDIT_RECORD_REDACTED' AND target_id = ${placeholder}`;
    });
    const result = await verifyAuditChain({ fromPosition: victim.position, toPosition: victim.position });
    const anomaly = result.anomalies.find((a) => a.kind === 'REDACTION_UNATTESTED');
    expect(anomaly?.id).toBe(victim.id);
    expect(anomaly?.message).toMatch(/before the row itself/);
  });
});
