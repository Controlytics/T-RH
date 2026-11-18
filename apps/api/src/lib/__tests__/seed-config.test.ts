import { describe, it, expect, vi } from 'vitest';
import { passwordPolicySchema } from '@digilog/shared';
import {
  systemConfigUpsertArgs, ensureSuperadmin, fieldIdUpsertArgs, helpArticleUpsertArgs,
} from '../../../prisma/seed-config.js';

vi.mock('../../modules/config/config.repository.js', () => ({
  configRepository: {
    // A row written by an older version: `requireUppercase` did not exist yet.
    getSystemConfig: vi.fn(async () => ({ configKey: 'password-policy', configValue: { minLength: 12 } })),
  },
}));
const { configService } = await import('../../modules/config/config.service.js');

/**
 * Audit 2026-11-07, S2-C1: every customer UPGRADE runs "migrate deploy + seed"
 * (`scripts/upgrade.ps1`, `scripts/linux/digilog-lib.sh`). The seed's
 * system_config upsert wrote the shipped defaults over password-policy,
 * login-security, session, datetime and the e-signature matrix (action-reauth
 * → {}), and its superadmin upsert set the account ENABLED again — with no
 * audit row. Both are create-only now: a missing row is created whole, an
 * existing one is never touched by a seed.
 */
describe('systemConfigUpsertArgs', () => {
  const cfg = { configKey: 'action-reauth', configValue: {}, configType: 'security', requiresReauth: false };

  it('never rewrites an existing setting', () => {
    expect(systemConfigUpsertArgs(cfg).update).toEqual({});
  });

  it('creates a missing setting whole', () => {
    const { where, create } = systemConfigUpsertArgs(cfg);
    expect(where).toEqual({ configKey: 'action-reauth' });
    expect(create).toEqual(cfg);
  });
});

describe('a setting the seed no longer rewrites', () => {
  // Create-only means an upgraded install keeps a row an older version wrote. Its
  // reader must still resolve a key that row predates — through the schema's own
  // default — and keep the value the administrator set.
  it('reads with the schema default for a key the stored row predates', async () => {
    const v = await configService.getConfig('password-policy', passwordPolicySchema);
    expect(v.minLength).toBe(12);
    expect(v.requireUppercase).toBe(true);
  });
});

/**
 * Final review of Batch 1 (the rest of S2-C1's class): an upgrade must not CREATE
 * an account either. The create-only upsert still re-created a deleted or renamed
 * `superadmin` as an ENABLED SUPER_ADMIN with no audit row. The seed now creates it
 * only on a database with NO users — a fresh install.
 */
describe('ensureSuperadmin', () => {
  const fakeClient = (users: number) => {
    const create = vi.fn(async (args: unknown) => args);
    return { client: { user: { count: vi.fn(async () => users), create } }, create };
  };

  it('creates the first SUPER_ADMIN on an EMPTY database', async () => {
    const { client, create } = fakeClient(0);
    expect(await ensureSuperadmin(client as never, 'hash')).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect((create.mock.calls[0][0] as { data: Record<string, unknown> }).data).toMatchObject({
      username: 'superadmin', role: 'SUPER_ADMIN', status: 'ENABLED', passwordHash: 'hash',
      forcePasswordChange: false, isTemporaryPassword: false, createdBy: 'system',
    });
  });

  it('creates NOTHING on a database that has users — a deleted or renamed superadmin stays gone', async () => {
    const { client, create } = fakeClient(7);
    expect(await ensureSuperadmin(client as never, 'hash')).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('fieldIdUpsertArgs', () => {
  const field = { fieldId: 'FLD_USER_001', defaultName: 'User ID', displayName: 'User ID', module: 'User Management', description: 'Unique user identifier' };

  it('never rewrites the display name an administrator set (PUT /api/config/field-ids/:id)', () => {
    expect(fieldIdUpsertArgs(field).update).not.toHaveProperty('displayName');
  });

  it('keeps the shipped default, module and description current', () => {
    expect(fieldIdUpsertArgs(field).update).toEqual({ defaultName: 'User ID', module: 'User Management', description: 'Unique user identifier' });
    expect(fieldIdUpsertArgs(field).create).toEqual(field);
  });
});

describe('helpArticleUpsertArgs', () => {
  it('never rewrites an article an administrator edited; a missing one is created whole', () => {
    const args = helpArticleUpsertArgs({ key: 'audit.overview', title: 'Audit Trail', category: 'audit', sortOrder: 1 }, 'body');
    expect(args.update).toEqual({});
    expect(args.where).toEqual({ key: 'audit.overview' });
    expect(args.create).toEqual({ key: 'audit.overview', title: 'Audit Trail', content: 'body', category: 'audit', sortOrder: 1 });
  });
});
