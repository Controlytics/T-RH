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
    import('../modules/config/defs/help.def.js'),
    import('../modules/config/defs/filter-cleaning-reasons.def.js'),
    import('../modules/config/defs/block-change-approval.def.js'),
    import('../modules/config/defs/pm-schedule-settings.def.js'),
    import('../modules/config/defs/pm-schedule-approval.def.js'),
    import('../modules/config/defs/replacement-schedule-approval.def.js'),
    import('../modules/config/defs/qnn-notifications.def.js'),
    import('../modules/config/defs/guest-cleaning-requests.def.js'),
    import('../modules/config/defs/ahu-filter-set-config.def.js'),
    import('../modules/config/defs/report-page-titles.def.js'),
    import('../modules/config/defs/report-signatories.def.js'),
    import('../modules/config/defs/report-labels.def.js'),
    import('../modules/config/defs/access-matrix.def.js'),
    import('../modules/config/defs/offline-cache.def.js'),
    import('../modules/config/defs/filter-field-options.def.js'),
    import('../modules/config/defs/export-options.def.js'),
    import('../modules/config/defs/replacement-schedule-filters.def.js'),
    import('../modules/config/defs/stage-interlock.def.js'),
    import('../modules/config/defs/ahu-completion-process.def.js'),
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

  // One-time migration: merge legacy `filter-pm-schedule.enabled` into `pm-schedule-settings`
  await migrateFilterPmScheduleIntoPmSettings();

  // One-time cleanup: remove dead config keys whose defs were deleted
  // (offline-sync + rfid-scanner settings were never read; role-privileges + sidebar-config pages never existed)
  await cleanupDeadConfigKeys();

  console.info(`[config-registry] ${configRegistry.size} modules registered`);
}

async function cleanupDeadConfigKeys(): Promise<void> {
  const { prisma } = await import('./prisma.js');
  const deadKeys = ['offline-sync', 'rfid-scanner', 'role-privileges', 'sidebar-config', 'uns', 'retention'];
  const res = await prisma.systemConfig.deleteMany({ where: { configKey: { in: deadKeys } } });
  if (res.count > 0) {
    console.info(`[config-migration] removed ${res.count} dead config row(s): ${deadKeys.join(', ')}`);
  }
}

async function migrateFilterPmScheduleIntoPmSettings(): Promise<void> {
  const { prisma } = await import('./prisma.js');
  const legacy = await prisma.systemConfig.findUnique({ where: { configKey: 'filter-pm-schedule' } });
  if (!legacy) return;
  const legacyValue = (legacy.configValue ?? {}) as Record<string, unknown>;
  const enabled = Boolean(legacyValue.enabled);

  const current = await prisma.systemConfig.findUnique({ where: { configKey: 'pm-schedule-settings' } });
  const currentValue = (current?.configValue ?? {}) as Record<string, unknown>;
  if (currentValue.enabled === undefined || currentValue.enabled === null) {
    await prisma.systemConfig.upsert({
      where: { configKey: 'pm-schedule-settings' },
      update: { configValue: { ...currentValue, enabled } },
      create: { configKey: 'pm-schedule-settings', configValue: { enabled } as any, configType: 'filter' },
    });
  }
  await prisma.systemConfig.delete({ where: { configKey: 'filter-pm-schedule' } });
  console.info('[config-migration] merged filter-pm-schedule into pm-schedule-settings');
}
