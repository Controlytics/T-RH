import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isHardDeleteEnabled,
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

describe('isHardDeleteEnabled', () => {
  const original = process.env.AUDIT_HARD_DELETE_ENABLED;
  beforeEach(() => { delete process.env.AUDIT_HARD_DELETE_ENABLED; });
  afterEach(() => {
    if (original === undefined) delete process.env.AUDIT_HARD_DELETE_ENABLED;
    else process.env.AUDIT_HARD_DELETE_ENABLED = original;
  });

  // The default MUST stay enabled: this system has always had the capability
  // and silently removing it in a patch release would break an operator
  // workflow without anyone deciding to. Turning it off is a deliberate act.
  it('defaults to enabled when the variable is unset', () => {
    expect(isHardDeleteEnabled()).toBe(true);
  });

  it('is disabled only by the exact string "false"', () => {
    process.env.AUDIT_HARD_DELETE_ENABLED = 'false';
    expect(isHardDeleteEnabled()).toBe(false);
  });

  // Fail SAFE for the operator's workflow, not closed: a typo must not
  // silently disable a governed capability they believe they still have.
  it.each(['true', 'FALSE', '0', '', 'no', 'off'])(
    'stays enabled for %o',
    (value) => {
      process.env.AUDIT_HARD_DELETE_ENABLED = value;
      expect(isHardDeleteEnabled()).toBe(true);
    },
  );
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
