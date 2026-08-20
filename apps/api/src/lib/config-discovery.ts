import { configRegistry } from './config-registry.js';

/**
 * Discover and register all module config definitions.
 * Called once at app startup before routes are registered.
 *
 * To add a new module's config:
 *   1. Create a config.def.ts in your module directory
 *   2. Add one import line below
 *   That's it — UI, routes, validation, and DB seeding are automatic.
 */
export async function discoverAndRegisterConfigs(): Promise<void> {
  const modules = await Promise.all([
    import('../modules/config/defs/password-policy.def.js'),
    import('../modules/config/defs/login-security.def.js'),
    import('../modules/config/defs/session.def.js'),
    import('../modules/config/defs/datetime.def.js'),
    import('../modules/config/defs/branding.def.js'),
    import('../modules/config/defs/user-id.def.js'),
    import('../modules/config/defs/pagination.def.js'),
    import('../modules/config/defs/export-limit.def.js'),
    import('../modules/config/defs/instrument-attributes.def.js'),
    import('../modules/config/defs/instrument-activity.def.js'),
    import('../modules/config/defs/telemetry-slots.def.js'),
    import('../modules/config/defs/action-reauth.def.js'),
    import('../modules/config/defs/audit-templates.def.js'),
    import('../modules/config/defs/notification-email.def.js'),
    import('../modules/config/defs/notification-sms.def.js'),
    import('../modules/config/defs/notification-rules.def.js'),
    import('../modules/config/defs/notification-logs.def.js'),
    import('../modules/config/defs/backup.def.js'),
    import('../modules/config/defs/roles.def.js'),
    import('../modules/config/defs/field-ids.def.js'),
    // retention.def + uns.def deleted with data-ingestion removal.
    // removed with the domain strip.
    import('../modules/config/defs/help.def.js'),
    import('../modules/config/defs/access-matrix.def.js'),
    import('../modules/config/defs/export-options.def.js'),
    import('../modules/config/defs/report-page-titles.def.js'),
    import('../modules/config/defs/alarm-limits.def.js'),
    // ─── Add new module configs below this line ───
  ]);

  for (const mod of modules) {
    const defs = Object.values(mod).filter(
      (v): v is any => v && typeof v === 'object' && 'moduleKey' in v && 'moduleName' in v
    );
    for (const def of defs) {
      configRegistry.register(def);
    }
  }

  // Auto-seed defaults for any newly registered configs
  await configRegistry.seedDefaults();

  // One-time cleanup: remove dead config keys whose defs were deleted
  // (offline-sync + rfid-scanner settings were never read; role-privileges + sidebar-config pages never existed)
  await cleanupDeadConfigKeys();

  console.info(`[config-registry] ${configRegistry.size} modules registered`);
}

async function cleanupDeadConfigKeys(): Promise<void> {
  const { prisma } = await import('./prisma.js');
  const deadKeys = [
    'offline-sync', 'rfid-scanner', 'role-privileges', 'sidebar-config', 'uns', 'retention',
    // Filter-domain keys (2026-08-20). Their defs went in the Phase 0 strip and
    // their single editing surface, /config/role-assignments, was deleted
    // 2026-08-19 — every read and write from it hit an unregistered route.
    // `filter-pm-schedule` had a boot-time migration that merged it into
    // `pm-schedule-settings`; both are swept here instead, since that migration
    // would otherwise CREATE the dead key it was migrating into.
    'filter-pm-schedule', 'pm-schedule-settings', 'pm-schedule-approval',
    'replacement-schedule-approval', 'qnn-notifications', 'guest-cleaning-requests',
    'block-change-approval', 'stage-interlock',
  ];
  const res = await prisma.systemConfig.deleteMany({ where: { configKey: { in: deadKeys } } });
  if (res.count > 0) {
    console.info(`[config-migration] removed ${res.count} dead config row(s): ${deadKeys.join(', ')}`);
  }
}

