import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultRoles } from './default-roles.js';

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

  for (const role of defaultRoles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {
        displayName: role.displayName,
        description: role.description,
        hierarchyLevel: role.hierarchyLevel,
        permissions: role.permissions,
        color: role.color,
        isSystem: role.isSystem,
      },
      create: {
        name: role.name,
        displayName: role.displayName,
        description: role.description,
        hierarchyLevel: role.hierarchyLevel,
        permissions: role.permissions,
        color: role.color,
        isSystem: role.isSystem,
        createdBy: 'system',
      },
    });
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

  // Filter field options — standalone upsert so re-seed never clobbers admin edits
  await prisma.systemConfig.upsert({
    where: { configKey: 'filter-field-options' },
    update: {}, // do not overwrite admin edits on re-seed
    create: {
      configKey: 'filter-field-options',
      configValue: {
        ahuType: ['Process', 'Non Process'],
        filterType: [],
        micronSize: [],
        filterSize: [],
      },
      configType: 'filter',
      requiresReauth: true,
    },
  });

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
    // Asset Management
    { fieldId: 'FLD_ASSET_001', defaultName: 'Name', displayName: 'Name', module: 'Asset Management', description: 'Asset instance name' },
    { fieldId: 'FLD_ASSET_002', defaultName: 'Template', displayName: 'Template', module: 'Asset Management', description: 'Associated template' },
    { fieldId: 'FLD_ASSET_003', defaultName: 'Parent', displayName: 'Parent', module: 'Asset Management', description: 'Parent asset in hierarchy' },
    { fieldId: 'FLD_ASSET_004', defaultName: 'Children', displayName: 'Children', module: 'Asset Management', description: 'Number of child assets' },
    { fieldId: 'FLD_ASSET_005', defaultName: 'Created', displayName: 'Created', module: 'Asset Management', description: 'Creation timestamp' },
    // Notifications
    { fieldId: 'FLD_NOTIF_001', defaultName: 'Rule Name', displayName: 'Rule Name', module: 'Notifications', description: 'Notification rule name' },
    { fieldId: 'FLD_NOTIF_002', defaultName: 'Event Type', displayName: 'Event Type', module: 'Notifications', description: 'Triggering event type' },
    { fieldId: 'FLD_NOTIF_003', defaultName: 'Channels', displayName: 'Channels', module: 'Notifications', description: 'Delivery channels (email, SMS, in-app)' },
    { fieldId: 'FLD_NOTIF_004', defaultName: 'Priority', displayName: 'Priority', module: 'Notifications', description: 'Rule priority order' },
    { fieldId: 'FLD_NOTIF_005', defaultName: 'Status', displayName: 'Status', module: 'Notifications', description: 'Active or inactive' },
    { fieldId: 'FLD_NOTIF_006', defaultName: 'Cooldown', displayName: 'Cooldown', module: 'Notifications', description: 'Cooldown period in minutes' },
    // (Telemetry + Alarms field IDs removed 2026-06-29 — those subsystems were
    //  torn out; the seed must not recreate them. Stale DB rows deleted too.)
    // Attributes
    { fieldId: 'FLD_ATTR_001', defaultName: 'Key', displayName: 'Key', module: 'Attributes', description: 'Attribute key name' },
    { fieldId: 'FLD_ATTR_002', defaultName: 'Value', displayName: 'Value', module: 'Attributes', description: 'Attribute value' },
    { fieldId: 'FLD_ATTR_003', defaultName: 'Last Updated', displayName: 'Last Updated', module: 'Attributes', description: 'Last update timestamp' },
    // Phase 2: Filter Operations
    { fieldId: 'FLD_FILTER_001', defaultName: 'Filter Name', displayName: 'Filter Name', module: 'Filter Operations', description: 'Filter instance name' },
    { fieldId: 'FLD_FILTER_002', defaultName: 'Filter Set', displayName: 'Filter Set', module: 'Filter Operations', description: 'Filter set (A or B)' },
    { fieldId: 'FLD_FILTER_003', defaultName: 'Current State', displayName: 'Current State', module: 'Filter Operations', description: 'Current lifecycle state' },
    { fieldId: 'FLD_FILTER_004', defaultName: 'Block', displayName: 'Block', module: 'Filter Operations', description: 'Cleaning area/block assignment' },
    { fieldId: 'FLD_FILTER_005', defaultName: 'Cleaning Reason', displayName: 'Cleaning Reason', module: 'Filter Operations', description: 'Reason for cleaning cycle' },
    { fieldId: 'FLD_FILTER_006', defaultName: 'Scan/ID', displayName: 'Scan/ID', module: 'Filter Operations', description: 'Scanned QR code or filter identifier' },
    // Cleaning Cycles
    { fieldId: 'FLD_CYCLE_001', defaultName: 'Cycle Code', displayName: 'Cycle Code', module: 'Cleaning Cycles', description: 'Unique cleaning cycle identifier' },
    { fieldId: 'FLD_CYCLE_002', defaultName: 'Filter', displayName: 'Filter', module: 'Cleaning Cycles', description: 'Associated filter name' },
    { fieldId: 'FLD_CYCLE_003', defaultName: 'Block', displayName: 'Block', module: 'Cleaning Cycles', description: 'Cleaning area/block' },
    { fieldId: 'FLD_CYCLE_004', defaultName: 'Reason', displayName: 'Reason', module: 'Cleaning Cycles', description: 'Cleaning reason' },
    { fieldId: 'FLD_CYCLE_005', defaultName: 'Status', displayName: 'Status', module: 'Cleaning Cycles', description: 'Cycle status' },
    { fieldId: 'FLD_CYCLE_006', defaultName: 'Progress', displayName: 'Progress', module: 'Cleaning Cycles', description: 'Stage progress indicators' },
    { fieldId: 'FLD_CYCLE_007', defaultName: 'Duration', displayName: 'Duration', module: 'Cleaning Cycles', description: 'Total cycle duration' },
    { fieldId: 'FLD_CYCLE_008', defaultName: 'Started', displayName: 'Started', module: 'Cleaning Cycles', description: 'Cycle start timestamp' },
    { fieldId: 'FLD_CYCLE_009', defaultName: 'Completed', displayName: 'Completed', module: 'Cleaning Cycles', description: 'Cycle completion timestamp' },
    // Cleaning Profiles
    { fieldId: 'FLD_CP_001', defaultName: 'Profile Name', displayName: 'Profile Name', module: 'Cleaning Profiles', description: 'Cleaning profile name' },
    { fieldId: 'FLD_CP_002', defaultName: 'Version', displayName: 'Version', module: 'Cleaning Profiles', description: 'Profile version number' },
    { fieldId: 'FLD_CP_003', defaultName: 'Status', displayName: 'Status', module: 'Cleaning Profiles', description: 'Profile status' },
    { fieldId: 'FLD_CP_004', defaultName: 'Flow Mode', displayName: 'Flow Mode', module: 'Cleaning Profiles', description: 'Pipeline flow mode' },
    { fieldId: 'FLD_CP_005', defaultName: 'Stages', displayName: 'Stages', module: 'Cleaning Profiles', description: 'Number of pipeline stages' },
    // Checklists
    { fieldId: 'FLD_CL_001', defaultName: 'Checklist Name', displayName: 'Checklist Name', module: 'Checklists', description: 'Checklist profile name' },
    { fieldId: 'FLD_CL_002', defaultName: 'Questions', displayName: 'Questions', module: 'Checklists', description: 'Number of questions' },
    { fieldId: 'FLD_CL_003', defaultName: 'Active', displayName: 'Active', module: 'Checklists', description: 'Checklist active status' },
    // Equipment Groups
    { fieldId: 'FLD_EQ_001', defaultName: 'Group Name', displayName: 'Group Name', module: 'Equipment Groups', description: 'Equipment group name' },
    { fieldId: 'FLD_EQ_002', defaultName: 'Block', displayName: 'Block', module: 'Equipment Groups', description: 'Associated block' },
    { fieldId: 'FLD_EQ_003', defaultName: 'Description', displayName: 'Description', module: 'Equipment Groups', description: 'Instrument description' },
    { fieldId: 'FLD_EQ_004', defaultName: 'Instrument ID', displayName: 'Instrument ID', module: 'Equipment Groups', description: 'Instrument identifier' },
    { fieldId: 'FLD_EQ_005', defaultName: 'Range', displayName: 'Range', module: 'Equipment Groups', description: 'Instrument min-max range' },
    { fieldId: 'FLD_EQ_006', defaultName: 'Operating Range', displayName: 'Operating Range', module: 'Equipment Groups', description: 'Operating min-max range' },
    { fieldId: 'FLD_EQ_007', defaultName: 'UOM', displayName: 'UOM', module: 'Equipment Groups', description: 'Unit of measurement' },
    { fieldId: 'FLD_EQ_008', defaultName: 'Least Count', displayName: 'Least Count', module: 'Equipment Groups', description: 'Instrument least count/resolution' },
    // PM Schedules
    { fieldId: 'FLD_PM_001', defaultName: 'Schedule Name', displayName: 'Schedule Name', module: 'PM Schedules', description: 'PM schedule name' },
    { fieldId: 'FLD_PM_002', defaultName: 'Entity', displayName: 'Entity', module: 'PM Schedules', description: 'Associated entity' },
    { fieldId: 'FLD_PM_003', defaultName: 'Interval', displayName: 'Interval', module: 'PM Schedules', description: 'Schedule interval in days' },
    { fieldId: 'FLD_PM_004', defaultName: 'Next Due', displayName: 'Next Due', module: 'PM Schedules', description: 'Next scheduled execution date' },
    { fieldId: 'FLD_PM_005', defaultName: 'Status', displayName: 'Status', module: 'PM Schedules', description: 'Schedule status' },
    // Filter Profiles
    { fieldId: 'FLD_FP_001', defaultName: 'Filter', displayName: 'Filter', module: 'Filter Profiles', description: 'Filter instance' },
    { fieldId: 'FLD_FP_002', defaultName: 'Cleaning Profile', displayName: 'Cleaning Profile', module: 'Filter Profiles', description: 'Assigned cleaning profile' },
    { fieldId: 'FLD_FP_003', defaultName: 'Assigned Date', displayName: 'Assigned Date', module: 'Filter Profiles', description: 'Profile assignment date' },
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
  const helpArticles = [
    { key: 'entity.overview', title: 'Entity Management Overview', category: 'entity', sortOrder: 1 },
    { key: 'entity.templates', title: 'Working with Entity Templates', category: 'entity', sortOrder: 2 },
    { key: 'entity.tree', title: 'Navigating the Entity Tree', category: 'entity', sortOrder: 3 },
    { key: 'entity.relationships', title: 'Entity Relationships Guide', category: 'entity', sortOrder: 4 },
    { key: 'entity.identifiers', title: 'Entity Identifiers (QR, RFID, NFC)', category: 'entity', sortOrder: 5 },
    { key: 'connectivity.overview', title: 'Device Connectivity Guide', category: 'connectivity', sortOrder: 1 },
    { key: 'connectivity.mqtt', title: 'MQTT Protocol Setup', category: 'connectivity', sortOrder: 2 },
    { key: 'connectivity.http', title: 'HTTP API Integration', category: 'connectivity', sortOrder: 3 },
    { key: 'connectivity.testing', title: 'Testing Device Connectivity', category: 'connectivity', sortOrder: 4 },
    { key: 'data.telemetry', title: 'Telemetry Data Guide', category: 'data', sortOrder: 1 },
    { key: 'data.attributes', title: 'Entity Attributes (Client/Server/Shared)', category: 'data', sortOrder: 2 },
    { key: 'data.binary', title: 'Binary Data (Images, Audio, Vibration)', category: 'data', sortOrder: 3 },
    { key: 'checklist.overview', title: 'Checklist System Overview', category: 'checklist', sortOrder: 1 },
    { key: 'checklist.mobile', title: 'Filling Checklists on Mobile', category: 'checklist', sortOrder: 2 },
    { key: 'checklist.qr-code', title: 'QR Code Scanning Guide', category: 'checklist', sortOrder: 3 },
    { key: 'checklist.approval', title: 'Checklist Approval Workflow', category: 'checklist', sortOrder: 4 },
    { key: 'uns.overview', title: 'Unified Namespace (UNS) Concepts', category: 'uns', sortOrder: 1 },
    { key: 'uns.isa95', title: 'ISA-95 Hierarchy Mapping', category: 'uns', sortOrder: 2 },
    { key: 'uns.wildcards', title: 'UNS Wildcard Patterns', category: 'uns', sortOrder: 3 },
    { key: 'audit.overview', title: 'Audit Trail & Compliance', category: 'audit', sortOrder: 1 },
    { key: 'users.roles', title: 'User Roles & Permissions', category: 'users', sortOrder: 1 },
    // Phase 2: Filter Management
    { key: 'filter-ops.overview', title: 'Filter Operations Overview', category: 'filter-operations', sortOrder: 1 },
    { key: 'filter-ops.scanning', title: 'Filter Scanning & Identification', category: 'filter-operations', sortOrder: 2 },
    { key: 'filter-ops.equipment', title: 'Equipment Groups & Instrument Readings', category: 'filter-operations', sortOrder: 3 },
    { key: 'cleaning-cycles.overview', title: 'Cleaning Cycle History', category: 'cleaning-cycles', sortOrder: 1 },
    { key: 'cleaning-cycles.timeline', title: 'Cycle Timeline & Events', category: 'cleaning-cycles', sortOrder: 2 },
    { key: 'cleaning-profiles.overview', title: 'Cleaning Profiles Overview', category: 'cleaning-profiles', sortOrder: 1 },
    { key: 'cleaning-profiles.editor', title: 'Pipeline Visual Editor', category: 'cleaning-profiles', sortOrder: 2 },
    { key: 'checklist-profiles.overview', title: 'Checklist Profiles Guide', category: 'checklist-profiles', sortOrder: 1 },
    { key: 'filter-profiles.overview', title: 'Filter Profile Assignment', category: 'filter-profiles', sortOrder: 1 },
    { key: 'equipment-groups.overview', title: 'Equipment Groups Configuration', category: 'equipment-groups', sortOrder: 1 },
    { key: 'pm-schedules.overview', title: 'PM Schedule Management', category: 'pm-schedules', sortOrder: 1 },
    { key: 'filter-lifecycle.overview', title: 'Filter Lifecycle States', category: 'filter-lifecycle', sortOrder: 1 },
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

  // 6. Seed system template kinds (BLOCK / AREA / AHU / FILTER / EQUIPMENT / OTHER).
  //    These are protected (isSystem=true) — admins can edit label/description/sortOrder
  //    but cannot rename code or delete them. Frontend pages route by code.
  const systemKinds = [
    { code: 'BLOCK',     label: 'Block',     description: 'Building wing or pharmacy module', sortOrder: 10 },
    { code: 'AREA',      label: 'Area',      description: 'Cleanroom / corridor / gowning room', sortOrder: 20 },
    { code: 'AHU',       label: 'AHU',       description: 'Air Handling Unit (HVAC)', sortOrder: 30 },
    { code: 'FILTER',    label: 'Filter',    description: 'Replaceable filter cartridge (HEPA / ULPA / pre-filter)', sortOrder: 40 },
    { code: 'EQUIPMENT', label: 'Equipment', description: 'Cleaning machine / dryer / instrument', sortOrder: 50 },
    { code: 'OTHER',     label: 'Other',     description: 'Generic / non-canonical template', sortOrder: 999 },
  ];
  for (const k of systemKinds) {
    await prisma.templateKind.upsert({
      where: { code: k.code },
      update: { label: k.label, description: k.description, sortOrder: k.sortOrder, isSystem: true },
      create: { code: k.code, label: k.label, description: k.description, sortOrder: k.sortOrder, isSystem: true, isActive: true },
    });
  }
  console.log(`  Seeded ${systemKinds.length} system template kinds`);

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
