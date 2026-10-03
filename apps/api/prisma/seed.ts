import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRoles } from './default-roles.js';
import { roleUpsertArgs } from './seed-roles.js';

const prisma = new PrismaClient();

/**
 * Apply DDL invariants Prisma cannot express (Phase 5b.5).
 * Idempotent — every statement uses IF NOT EXISTS / OR REPLACE.
 */
async function applyInvariants() {
  const sqlPath = join(process.cwd(), 'prisma', 'sql', 'invariants.sql');
  let sql: string;
  try {
    sql = readFileSync(sqlPath, 'utf8');
  } catch {
    console.log('  (no invariants.sql found — skipping)');
    return;
  }
  // Strip psql meta-commands (\echo etc.) — only valid via psql CLI.
  const cleaned = sql.split('\n').filter(l => !l.trim().startsWith('\\')).join('\n');
  // Split on semicolons but keep PL/pgSQL function bodies intact via $$ delimiters.
  const statements: string[] = [];
  let buf = '';
  let inDollar = false;
  for (const line of cleaned.split('\n')) {
    if (line.includes('$$')) inDollar = !inDollar;
    buf += line + '\n';
    if (!inDollar && /;\s*$/.test(line)) { statements.push(buf.trim()); buf = ''; }
  }
  if (buf.trim()) statements.push(buf.trim());
  for (const stmt of statements) {
    if (!stmt || stmt.startsWith('--')) continue;
    await prisma.$executeRawUnsafe(stmt);
  }
  console.log('  Applied DB invariants (Phase 5b.5)');
}

async function main() {
  console.log('Seeding database...');

  // 1. Create default roles (imported from ./default-roles.ts — pure data, no side effects)

  // An EXISTING role keeps its permissions and hierarchy level — see
  // ./seed-roles.ts (audit 2026-10-03, DATA-4): the upgrade path reseeds.
  for (const role of defaultRoles) {
    await prisma.role.upsert(roleUpsertArgs(role));
  }
  console.log('  Created default roles');

  // 2. Create default SUPER_ADMIN
  const defaultPassword = process.env.INITIAL_ADMIN_PASSWORD;
  if (!defaultPassword) {
    throw new Error('FATAL: INITIAL_ADMIN_PASSWORD env var must be set for seeding. Cannot use hardcoded default.');
  }
  const passwordHash = await bcrypt.hash(defaultPassword, 12);

  await prisma.user.upsert({
    where: { username: 'superadmin' },
    update: {
      fullName: 'System Administrator',
      email: 'admin@digilog.local',
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
    },
    create: {
      username: 'superadmin',
      fullName: 'System Administrator',
      email: 'admin@digilog.local',
      passwordHash,
      role: 'SUPER_ADMIN',
      status: 'ENABLED',
      forcePasswordChange: false,
      isTemporaryPassword: false,
      createdBy: 'system',
    },
  });

  // Add to password history
  const admin = await prisma.user.findUnique({ where: { username: 'superadmin' } });
  if (admin) {
    const existingHistory = await prisma.passwordHistory.findFirst({ where: { userId: admin.id } });
    if (!existingHistory) {
      await prisma.passwordHistory.create({
        data: { userId: admin.id, passwordHash },
      });
    }
  }

  console.log('  Created default admin user (superadmin / ******* — set INITIAL_ADMIN_PASSWORD env var)');

  // 3. System configurations
  const configs = [
    {
      configKey: 'password-policy',
      configValue: {
        minLength: 8, maxLength: 128,
        requireUppercase: true, requireLowercase: true,
        requireNumbers: true, requireSpecialChars: true,
        minUppercase: 1, minLowercase: 1, minNumbers: 1, minSpecialChars: 1,
        preventReuseCount: 12, cannotBeUserId: true, cannotContainUserId: true,
        // Password expiry
        passwordExpiryDays: 90,
        expiryNotificationDays: 0,
        // Login security settings
        maxFailedAttempts: 5,
        // Session settings
        autoLogoutEnabled: true, idleTimeoutMinutes: 15, warningMinutes: 2,
      },
      configType: 'security',
      requiresReauth: true,
    },
    {
      configKey: 'login-security',
      configValue: {
        lockoutType: 'TEMPORARY',
        lockoutDurationMinutes: 30,
      },
      configType: 'security',
      requiresReauth: true,
    },
    {
      configKey: 'session',
      configValue: {
        autoLogoutEnabled: true,
        idleTimeoutMinutes: 15,
        warningMinutes: 2,
      },
      configType: 'security',
      requiresReauth: true,
    },
    {
      configKey: 'datetime',
      configValue: {
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '24-hour',
        timezone: 'UTC',
      },
      configType: 'display',
      requiresReauth: false,
    },
    {
      configKey: 'action-reauth',
      // Flat record shape: { actionKey: roleNames[] }. Every reader (frontend
      // page, isReauthRequired, getMyActions, actionReauthConfigSchema) uses
      // this shape. The previous nested `{ actions: [{action, roles}, ...] }`
      // shape silently disabled every reauth lookup (config[action] was always
      // undefined) and made the PUT validator reject any save.
      //
      // Seeded empty so the system ships with reauth OFF by default.
      // Operators opt actions in via the action-reauth admin page. Defaulting
      // the policy on at install would surprise both existing tests (170+
      // assertions written against the de-facto OFF state) and existing
      // deployments that rely on no reauth being required.
      configValue: {},
      configType: 'security',
      requiresReauth: false,
    },
  ];

  for (const config of configs) {
    await prisma.systemConfig.upsert({
      where: { configKey: config.configKey },
      update: {
        configValue: config.configValue,
        configType: config.configType,
        requiresReauth: config.requiresReauth,
      },
      create: config,
    });
  }
  console.log('  Created default system configurations');

  // Configuration Access matrix — { [moduleKey]: roleNames[] }.
  // Phase 2 (gap S1) flipped config-card visibility to DEFAULT-DENY: a module with no
  // matrix entry is hidden from non-SUPER_ADMIN roles. Without this seed, a fresh install
  // has an empty matrix, so ADMIN (the only non-SA role reaching /config) would lose the
  // four general config cards. Grant ADMIN those cards it has always seen. SUPER_ADMIN
  // bypasses the matrix entirely. create-only (update:{}) so a re-seed never clobbers a
  // SUPER_ADMIN's configured grants (e.g. delegations to SUPERVISOR/QA/custom roles).
  await prisma.systemConfig.upsert({
    where: { configKey: 'access-matrix' },
    update: {}, // never overwrite a SUPER_ADMIN's configured matrix on re-seed
    create: {
      configKey: 'access-matrix',
      configValue: {
        'password-policy': ['ADMIN'],
        'datetime': ['ADMIN'],
        'backup': ['ADMIN'],
        'user-id': ['ADMIN'],
      },
      configType: 'security',
      requiresReauth: false,
    },
  });

  // 4. Field ID configurations
  const fieldIds = [
    // User Management
    { fieldId: 'FLD_USER_001', defaultName: 'User ID', displayName: 'User ID', module: 'User Management', description: 'Unique user identifier' },
    { fieldId: 'FLD_USER_002', defaultName: 'Full Name', displayName: 'Full Name', module: 'User Management', description: 'User full name' },
    { fieldId: 'FLD_USER_003', defaultName: 'Email', displayName: 'Email', module: 'User Management', description: 'User email address' },
    { fieldId: 'FLD_USER_004', defaultName: 'Department', displayName: 'Department', module: 'User Management', description: 'User department' },
    { fieldId: 'FLD_USER_005', defaultName: 'Role', displayName: 'Role', module: 'User Management', description: 'User role assignment' },
    { fieldId: 'FLD_USER_006', defaultName: 'Status', displayName: 'Status', module: 'User Management', description: 'User account status' },
    // Audit Trail
    { fieldId: 'FLD_AUDIT_001', defaultName: 'Timestamp', displayName: 'Timestamp', module: 'Audit Trail', description: 'When the action occurred' },
    { fieldId: 'FLD_AUDIT_002', defaultName: 'Description', displayName: 'Description', module: 'Audit Trail', description: 'Summary of the audit event' },
    { fieldId: 'FLD_AUDIT_003', defaultName: 'Action', displayName: 'Action', module: 'Audit Trail', description: 'Type of action performed' },
    { fieldId: 'FLD_AUDIT_004', defaultName: 'Performed By', displayName: 'Performed By', module: 'Audit Trail', description: 'User who performed the action' },
    { fieldId: 'FLD_AUDIT_005', defaultName: 'Status', displayName: 'Status', module: 'Audit Trail', description: 'Integrity verification status' },
    // Notifications
    { fieldId: 'FLD_NOTIF_001', defaultName: 'Rule Name', displayName: 'Rule Name', module: 'Notifications', description: 'Notification rule name' },
    { fieldId: 'FLD_NOTIF_002', defaultName: 'Event Type', displayName: 'Event Type', module: 'Notifications', description: 'Triggering event type' },
    { fieldId: 'FLD_NOTIF_003', defaultName: 'Channels', displayName: 'Channels', module: 'Notifications', description: 'Delivery channels (email, SMS, in-app)' },
    { fieldId: 'FLD_NOTIF_004', defaultName: 'Priority', displayName: 'Priority', module: 'Notifications', description: 'Rule priority order' },
    { fieldId: 'FLD_NOTIF_005', defaultName: 'Status', displayName: 'Status', module: 'Notifications', description: 'Active or inactive' },
    { fieldId: 'FLD_NOTIF_006', defaultName: 'Cooldown', displayName: 'Cooldown', module: 'Notifications', description: 'Cooldown period in minutes' },
    // (Domain field IDs — Asset/Attributes/Filter/Cycle/Cleaning Profile/Checklist/
    //  Equipment/PM/Filter Profile — removed with the domain strip 2026-07-18.)
  ];

  for (const field of fieldIds) {
    await prisma.fieldIdConfig.upsert({
      where: { fieldId: field.fieldId },
      update: {
        defaultName: field.defaultName,
        displayName: field.displayName,
        module: field.module,
        description: field.description,
      },
      create: field,
    });
  }
  console.log('  Created default field ID configurations');

  // 5. Default Help Articles (from Appendix B)
  // Domain help articles (entity/connectivity/data/checklist/uns/filter-*/cleaning-*/
  // pm-*/equipment) removed with the domain strip 2026-07-18. Only the generic
  // compliance/admin articles remain.
  const helpArticles = [
    { key: 'audit.overview', title: 'Audit Trail & Compliance', category: 'audit', sortOrder: 1 },
    { key: 'users.roles', title: 'User Roles & Permissions', category: 'users', sortOrder: 1 },
  ];

  for (const article of helpArticles) {
    await prisma.helpArticle.upsert({
      where: { key: article.key },
      update: {
        title: article.title,
        content: `# ${article.title}\n\nThis article covers the key concepts and usage guidelines for ${article.title.toLowerCase()}. For detailed instructions, please refer to the system documentation or contact your administrator.`,
        category: article.category,
        sortOrder: article.sortOrder,
      },
      create: {
        key: article.key,
        title: article.title,
        content: `# ${article.title}\n\nThis article covers the key concepts and usage guidelines for ${article.title.toLowerCase()}. For detailed instructions, please refer to the system documentation or contact your administrator.`,
        category: article.category,
        sortOrder: article.sortOrder,
      },
    });
  }
  console.log('  Created default help articles (33 articles)');

  await applyInvariants();

  console.log('Seed completed successfully!');
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
