import { describe, it, expect, vi } from 'vitest';
import { auditLog } from '../audit.js';

// writeAuditRow() runs against whatever `tx` is handed into the
// $transaction callback (advisory lock + chain-position query + insert
// all go through it), so the tx must expose the same $executeRaw /
// $queryRaw / auditTrail.create surface as `prisma` itself — reuse one
// object for both rather than passing an empty stub. vi.mock factories
// are hoisted above module-level code, so the shared object has to be
// built via vi.hoisted() rather than a plain `const` referenced by the
// factory closure.
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma: any = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $queryRaw: vi.fn().mockResolvedValue([]),
    auditTrail: { create: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(null) },
  };
  mockPrisma.$transaction = vi.fn(async (fn: any) => (typeof fn === 'function' ? fn(mockPrisma) : []));
  return { mockPrisma };
});

vi.mock('../prisma.js', () => ({ prisma: mockPrisma }));

const SYSTEM_EMITTED = [
  'ALARM_RAISED', 'ALARM_REBREACHED', 'ALARM_RESOLVED',
  'DEVICE_WENT_OFFLINE', 'DEVICE_CAME_ONLINE',
];

describe('system-emitted alarm audit actions', () => {
  it.each(SYSTEM_EMITTED)('%s can be logged without a userId', async (action) => {
    // These are emitted from the ingest flush loop and the liveness cron, where
    // no user principal exists. auditLog throws for a userId-less action that is
    // not allow-listed — and flushNow's interval callback swallows errors, so an
    // un-allow-listed action stops alarms silently while ingestion looks fine.
    await expect(auditLog({ action, targetType: 'Alarm', targetId: 'x' })).resolves.not.toThrow();
  });

  it('ALARM_ACKNOWLEDGED still requires a userId', async () => {
    // The acknowledgement is the e-signature. It must never be attributable to
    // nobody, so it is deliberately NOT on the allow-list.
    await expect(auditLog({ action: 'ALARM_ACKNOWLEDGED', targetType: 'Alarm', targetId: 'x' }))
      .rejects.toThrow(/userId required/);
  });
});
