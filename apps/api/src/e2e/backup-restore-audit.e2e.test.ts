import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { verifyAuditChain } from '../lib/audit-verify.js';
import { exportJson, restore } from '../modules/backup/backup.service.js';
import type { RequestContext } from '../types/context.js';

/**
 * Audit 2026-10-12 #2 (restore half): BACKUP_RESTORED is written INSIDE the
 * restore transaction, after the audit_trail has been replaced and the chain
 * counter resynced, so it chains onto the RESTORED trail's last row and a
 * failed audit insert rolls the whole restore back. Until then restore
 * committed first and wrote the row standalone: a failed write left the
 * database replaced with no record of who replaced it.
 *
 * `force: true` throughout: this shared test database carries hard-delete gaps
 * left by audit.test.ts by design, which the archive chain check refuses.
 */
const STAMP = String(Date.now()).slice(-6);
const FN = `rst_refuse_audit_${STAMP}`;
const TRG = `rst_refuse_audit_trg_${STAMP}`;
const MARKER = `e2e-restore-marker-${STAMP}`;
const ctx = { userId: 'admin', userRole: 'SUPER_ADMIN', userSub: 'admin', ipAddress: '127.0.0.1', userAgent: 'vitest', sessionId: null } as unknown as RequestContext;

async function dropTrigger() {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${TRG} ON audit_trail`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS ${FN}()`);
}
async function archiveBuffer(): Promise<{ buf: Buffer; lastPosition: number; lastChecksum: string }> {
  const { backup } = await exportJson('admin', ctx);
  const rows = backup.data.audit_trail as Array<{ chain_position: string | number; checksum: string }>;
  const last = rows.reduce((a, b) => (Number(b.chain_position) > Number(a.chain_position) ? b : a));
  return { buf: Buffer.from(JSON.stringify(backup)), lastPosition: Number(last.chain_position), lastChecksum: last.checksum };
}

afterAll(async () => {
  try { await dropTrigger(); } catch (e) { console.error('trigger cleanup failed', e); }
  try { await prisma.systemConfig.deleteMany({ where: { configKey: MARKER } }); } catch (e) { console.error(e); }
});

describe('restore writes BACKUP_RESTORED inside its own transaction', () => {
  it('a failed BACKUP_RESTORED insert rolls the whole restore back', async () => {
    const { buf } = await archiveBuffer();
    // Written AFTER the export: a restore that committed would remove it.
    await prisma.systemConfig.create({ data: { configKey: MARKER, configValue: { marker: true }, configType: 'system' } });
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION ${FN}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.action = 'BACKUP_RESTORED' THEN RAISE EXCEPTION 'test: audit insert refused'; END IF;
        RETURN NEW;
      END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER ${TRG} BEFORE INSERT ON audit_trail FOR EACH ROW EXECUTE FUNCTION ${FN}()`);
    try {
      await expect(restore(buf, ctx, { force: true })).rejects.toThrow();
    } finally {
      await dropTrigger();
    }
    expect(await prisma.systemConfig.count({ where: { configKey: MARKER } })).toBe(1);
  }, 300_000);

  it('BACKUP_RESTORED chains onto the restored trail\'s last row, and the chain from there verifies', async () => {
    await prisma.systemConfig.deleteMany({ where: { configKey: MARKER } });
    const { buf, lastPosition, lastChecksum } = await archiveBuffer();
    const res = await restore(buf, ctx, { force: true });
    expect(res.success).toBe(true);
    const [head] = await prisma.$queryRaw<Array<{ action: string; chain_position: bigint; previous_checksum: string }>>`
      SELECT action, chain_position, previous_checksum FROM audit_trail ORDER BY chain_position DESC LIMIT 1`;
    expect(head.action).toBe('BACKUP_RESTORED');
    expect(Number(head.chain_position)).toBe(lastPosition + 1);
    expect(head.previous_checksum).toBe(lastChecksum);
    const result = await verifyAuditChain({ fromPosition: lastPosition });
    expect(result.anomalies).toEqual([]);
    // And the next ordinary write continues the chain densely.
    const { auditLog } = await import('../lib/audit.js');
    await auditLog({ userId: 'admin', userRole: 'SUPER_ADMIN', action: 'CONFIG_CHANGED', targetType: 'e2e', targetId: MARKER });
    expect((await verifyAuditChain({ fromPosition: lastPosition })).anomalies).toEqual([]);
  }, 300_000);
});
