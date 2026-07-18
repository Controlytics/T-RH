// Side-effect import: loads .env and redirects DATABASE_URL onto
// digilog_test_db BEFORE the PrismaClient below is constructed. Must be the
// first import so the swap wins.
import './vitest.env.js';

// Tests run against the dedicated digilog_test_db (isolated from the real
// digilog_db audit trail — see vitest.env.ts). e2e helpers default to user
// 'admin' with password 'Admin@123'; ensure that user exists with the ADMIN
// role before any test runs. Idempotent.
export default async function setup(): Promise<void> {
  const { PrismaClient } = await import('@prisma/client');
  const { hashPassword } = await import('./src/lib/password.js');
  const prisma = new PrismaClient();
  try {
    const adminRole = await prisma.role.findFirst({ where: { name: 'SUPER_ADMIN' } });
    if (!adminRole) {
      // Schema seed missing the SUPER_ADMIN role — bail noisily so it's obvious in CI.
      throw new Error(
        'vitest globalSetup: SUPER_ADMIN role missing from digilog_db. Run `npx tsx prisma/seed.ts` first.',
      );
    }

    // Ensure VIEWER exists too. Older dev DBs were seeded before VIEWER was
    // added (e2e/roles.test.ts asserts it as a default system role); upsert
    // is idempotent so this is safe to run on every test launch.
    await prisma.role.upsert({
      where: { name: 'VIEWER' },
      update: {},
      create: {
        name: 'VIEWER',
        displayName: 'Viewer',
        description: 'View-only access (test fixture)',
        hierarchyLevel: 1,
        permissions: ['AUDIT_READ', 'ASSET_VIEW', 'ASSET_READ', 'ALARM_VIEW', 'DASHBOARD_VIEW'],
        color: 'bg-gradient-to-r from-slate-400 to-slate-500',
        isSystem: true,
      },
    });

    const passwordHash = await hashPassword('Admin@123');

    const existing = await prisma.user.findUnique({ where: { username: 'admin' } });
    if (existing) {
      await prisma.user.update({
        where: { id: existing.id },
        data: {
          passwordHash,
          role: 'SUPER_ADMIN',
          status: 'ENABLED',
          forcePasswordChange: false,
          isTemporaryPassword: false,
          failedLoginAttempts: 0,
          lockedAt: null,
          lockoutUntil: null,
          email: existing.email ?? 'admin-test@digilog.local',
          fullName: existing.fullName ?? 'Test Admin',
        },
      });
    } else {
      await prisma.user.create({
        data: {
          username: 'admin',
          email: 'admin-test@digilog.local',
          fullName: 'Test Admin',
          role: 'SUPER_ADMIN',
          status: 'ENABLED',
          passwordHash,
          forcePasswordChange: false,
          isTemporaryPassword: false,
        },
      });
    }

    // checklist-submission.test.ts (and any other test that needs a
    // non-admin actor) logs in as RB0001 / Test@1234 to verify operator
    // RBAC paths. Upsert idempotently with the OPERATOR role.
    const operatorPassword = await hashPassword('Test@1234');
    await prisma.user.upsert({
      where: { username: 'RB0001' },
      update: {
        passwordHash: operatorPassword,
        role: 'OPERATOR',
        status: 'ENABLED',
        forcePasswordChange: false,
        isTemporaryPassword: false,
        failedLoginAttempts: 0,
        lockedAt: null,
        lockoutUntil: null,
      },
      create: {
        username: 'RB0001',
        email: 'rb0001-test@digilog.local',
        fullName: 'Test Operator',
        role: 'OPERATOR',
        status: 'ENABLED',
        passwordHash: operatorPassword,
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });
  } finally {
    await prisma.$disconnect();
  }
}
