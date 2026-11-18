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
        permissions: ['AUDIT_READ', 'INSTRUMENT_READ', 'ALARM_READ', 'DASHBOARD_VIEW'],
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
    //
    // `passwordChangedAt` is stamped NOW on every run (2026-11-02): the password
    // is re-set here, so it is a fresh one. Without the stamp the expiry clock
    // ran from the row's `createdAt` (2026-08-04) and the 90-day policy expired
    // RB0001 on 2026-11-02 — every OPERATOR request then answered 403
    // PASSWORD_EXPIRED, which read as 65 "operator is forbidden" failures across
    // 12 suites. A non-SUPER_ADMIN fixture user must never age into expiry.
    const operatorPassword = await hashPassword('Test@1234');
    const passwordChangedAt = new Date();
    await prisma.user.upsert({
      where: { username: 'RB0001' },
      update: {
        passwordHash: operatorPassword,
        passwordChangedAt,
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
        passwordChangedAt,
        forcePasswordChange: false,
        isTemporaryPassword: false,
      },
    });

    // RB0001's ROLE is reset to the shipped OPERATOR too (2026-11-17). Suites
    // change the shared OPERATOR role (permissions, instrument scope) and hand
    // it back in `afterAll` — which never runs when a run is KILLED mid-file.
    // Every later suite that snapshots "before" and restores it then saves the
    // changed value as its baseline and faithfully writes it back, so one
    // killed run poisons every run after it. Seen 2026-11-16: a stopped run left
    // OPERATOR holding functional-location-scoped-membership's grant set
    // (INSTRUMENT_READ + FUNCTIONAL_LOCATION_READ/UPDATE), and
    // instruments.test.ts's permission gate answered 200 for "a non-privileged
    // role" — which read as a broken gate, not a dirty fixture. The list is read
    // from default-roles.ts, never retyped, so it cannot drift from the seed.
    const { Prisma } = await import('@prisma/client');
    const { defaultRoles } = await import('./prisma/default-roles.js');
    const shippedOperator = defaultRoles.find((r) => r.name === 'OPERATOR');
    if (!shippedOperator) {
      throw new Error('vitest globalSetup: OPERATOR missing from prisma/default-roles.ts');
    }
    await prisma.role.update({
      where: { name: 'OPERATOR' },
      data: { permissions: [...shippedOperator.permissions] },
    });
    // No row = unrestricted, and a row with NULL scope = unrestricted: clear an
    // existing row's scope, never create one.
    await prisma.roleConfig.updateMany({
      where: { role: 'OPERATOR' },
      data: { instrumentScope: Prisma.DbNull },
    });
  } finally {
    await prisma.$disconnect();
  }
}
