import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { prisma } from '../prisma.js';
import {
  isHardDeleteEnabled,
  AUDIT_HARD_DELETE_CONFIG_KEY,
  PROTECTED_AUDIT_ACTIONS,
  withTriggersDisabled,
  withAuditDeletesAllowed,
  AUDIT_NO_DELETE_TRIGGER,
} from '../audit-immutability.js';

/** Minimal tx double that records every statement in order. */
function fakeTx(triggers: string[] = [AUDIT_NO_DELETE_TRIGGER]) {
  const statements: string[] = [];
  return {
    statements,
    $queryRawUnsafe: vi.fn(async () => triggers.map((tgname) => ({ tgname }))),
    $executeRawUnsafe: vi.fn(async (sql: string) => {
      statements.push(sql);
      return 0;
    }),
  };
}

// 2026-10-12 (operator): hard delete is a Configuration TOGGLE, default OFF.
// The env var is no longer read. These read the real `system_config` row in the
// test database, so the original row is captured and restored FIRST.
describe('isHardDeleteEnabled', () => {
  let original: { configValue: unknown; configType: string; requiresReauth: boolean } | null = null;
  const envBefore = process.env.AUDIT_HARD_DELETE_ENABLED;
  beforeAll(async () => {
    const row = await prisma.systemConfig.findUnique({ where: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY } });
    original = row ? { configValue: row.configValue, configType: row.configType, requiresReauth: row.requiresReauth } : null;
  });
  afterAll(async () => {
    if (original) await prisma.systemConfig.upsert({ where: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY }, update: original as never, create: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY, ...original } as never });
    else await prisma.systemConfig.deleteMany({ where: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY } });
    if (envBefore === undefined) delete process.env.AUDIT_HARD_DELETE_ENABLED;
    else process.env.AUDIT_HARD_DELETE_ENABLED = envBefore;
  });
  const set = (value: unknown) => prisma.systemConfig.upsert({
    where: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY },
    update: { configValue: value as never },
    create: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY, configValue: value as never, configType: 'security', requiresReauth: false },
  });

  it('is OFF when no row exists', async () => {
    await prisma.systemConfig.deleteMany({ where: { configKey: AUDIT_HARD_DELETE_CONFIG_KEY } });
    expect(await isHardDeleteEnabled()).toBe(false);
  });

  it('is ON only when the toggle is exactly true', async () => {
    await set({ enabled: true });
    expect(await isHardDeleteEnabled()).toBe(true);
  });

  // Fail CLOSED: a half-seeded or hand-edited row must never open the one
  // route that destroys §11 history.
  it.each([{ enabled: false }, { enabled: 'true' }, { enabled: 1 }, {}, { enabled: null }])(
    'is OFF for %o',
    async (value) => {
      await set(value);
      expect(await isHardDeleteEnabled()).toBe(false);
    },
  );

  it('ignores the retired AUDIT_HARD_DELETE_ENABLED variable', async () => {
    await set({ enabled: false });
    process.env.AUDIT_HARD_DELETE_ENABLED = 'true';
    expect(await isHardDeleteEnabled()).toBe(false);
  });
});

describe('PROTECTED_AUDIT_ACTIONS', () => {
  it('names the four meta actions that record a deletion or a redaction', () => {
    expect([...PROTECTED_AUDIT_ACTIONS].sort()).toEqual([
      'AUDIT_RECORDS_BULK_DELETED', 'AUDIT_RECORDS_BULK_REDACTED', 'AUDIT_RECORD_DELETED', 'AUDIT_RECORD_REDACTED',
    ]);
  });
});

describe('withTriggersDisabled', () => {
  it('disables before the callback and re-enables after it', async () => {
    const tx = fakeTx();
    const order: string[] = [];
    await withTriggersDisabled(tx, 'audit_trail', [AUDIT_NO_DELETE_TRIGGER], async () => {
      order.push('callback');
    });

    expect(tx.statements[0]).toContain('DISABLE TRIGGER');
    expect(tx.statements[1]).toContain('ENABLE TRIGGER');
    expect(order).toEqual(['callback']);
  });

  it('returns the callback result', async () => {
    const tx = fakeTx();
    await expect(
      withTriggersDisabled(tx, 'audit_trail', [AUDIT_NO_DELETE_TRIGGER], async () => 42),
    ).resolves.toBe(42);
  });

  // THE REGRESSION TEST for the `finally`. Before this module the re-enable sat
  // on the success path in all three copies of this code. Nothing failed,
  // because Postgres rolls transactional DDL back — but the guarantee rested on
  // an invariant nothing stated, and one refactor outside a transaction would
  // have left §11 immutability disabled with no error anywhere.
  it('re-enables the trigger even when the callback throws', async () => {
    const tx = fakeTx();
    await expect(
      withTriggersDisabled(tx, 'audit_trail', [AUDIT_NO_DELETE_TRIGGER], async () => {
        throw new Error('delete blew up');
      }),
    ).rejects.toThrow('delete blew up');

    expect(tx.statements).toHaveLength(2);
    expect(tx.statements[0]).toContain('DISABLE TRIGGER');
    expect(tx.statements[1]).toContain('ENABLE TRIGGER');
  });

  it('propagates the original error, not one from the finally', async () => {
    const tx = fakeTx();
    await expect(
      withTriggersDisabled(tx, 'audit_trail', [AUDIT_NO_DELETE_TRIGGER], async () => {
        throw new Error('original');
      }),
    ).rejects.toThrow('original');
  });

  // A database that legitimately lacks the trigger must still work — this is
  // why the implementation queries pg_trigger instead of naming it blindly.
  it('is a no-op wrapper when the trigger is not present', async () => {
    const tx = fakeTx([]);
    await expect(
      withTriggersDisabled(tx, 'audit_trail', [AUDIT_NO_DELETE_TRIGGER], async () => 'ok'),
    ).resolves.toBe('ok');
    expect(tx.statements).toEqual([]);
  });

  it('handles multiple triggers, re-enabling every one', async () => {
    const tx = fakeTx(['t_one', 't_two']);
    await withTriggersDisabled(tx, 'audit_trail', ['t_one', 't_two'], async () => {});
    expect(tx.statements.filter((s) => s.includes('DISABLE'))).toHaveLength(2);
    expect(tx.statements.filter((s) => s.includes('ENABLE'))).toHaveLength(2);
  });

  it.each([
    'audit_trail"; DROP TABLE users; --',
    '1_starts_with_digit',
    'has-a-hyphen',
    '',
  ])('refuses unsafe table identifier %o', async (table) => {
    const tx = fakeTx();
    await expect(
      withTriggersDisabled(tx, table, [AUDIT_NO_DELETE_TRIGGER], async () => {}),
    ).rejects.toThrow(/unsafe SQL identifier/);
    expect(tx.statements).toEqual([]);
  });

  it('refuses an unsafe trigger identifier', async () => {
    const tx = fakeTx();
    await expect(
      withTriggersDisabled(tx, 'audit_trail', ['bad"; DROP TABLE users; --'], async () => {}),
    ).rejects.toThrow(/unsafe SQL identifier/);
  });
});

describe('withAuditDeletesAllowed', () => {
  it('targets audit_trail and its no-delete trigger', async () => {
    const tx = fakeTx();
    await withAuditDeletesAllowed(tx, async () => {});
    expect(tx.statements[0]).toBe(
      `ALTER TABLE "audit_trail" DISABLE TRIGGER "${AUDIT_NO_DELETE_TRIGGER}"`,
    );
    expect(tx.statements[1]).toBe(
      `ALTER TABLE "audit_trail" ENABLE TRIGGER "${AUDIT_NO_DELETE_TRIGGER}"`,
    );
  });
});
