import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Offline-cache settings — SUPER_ADMIN-only.
 *
 * `cacheStalenessHours` controls the client TTL on snapshot caches (filter
 * state, templates, cleaning reasons, equipment groups). After the configured
 * window, the next client read treats the cache as stale and forces a refetch.
 * Previously hardcoded: 24h on mobile, no TTL on desktop. Now both sides honor
 * the configured value.
 *
 * `cacheHardCutoffHours` controls the read-only-lockout window. If the client
 * has had no successful server contact for that many hours, the UI enters
 * read-only mode (banner + blocker; mutations refused) until contact is
 * re-established. Designed for the 21 CFR Part 11 posture where the operator
 * must not continue producing records against an unreachable server.
 *
 * `requiredRole: 'SUPER_ADMIN'` ensures the config card and dynamic page only
 * appear to SUPER_ADMIN. The route gate (see `static-routes/offline-cache.routes.ts`)
 * enforces this server-side independently.
 */
export const offlineCacheDef: ModuleConfigDefinition = {
  moduleKey: 'offline-cache',
  moduleName: 'Offline Cache & Lockout',
  description: 'Configure how long client caches stay fresh and when the app enters read-only mode after losing server contact',
  icon: 'cloud-off',
  category: 'advanced',
  sortOrder: 30,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: true,
  reauthAction: 'UPDATE_OFFLINE_CACHE_CONFIG',
  hasCustomPage: true,
  customPagePath: '/config/offline-cache',
  settings: [
    {
      key: 'cacheStalenessHours',
      type: 'number',
      label: 'Cache Staleness (hours)',
      description: 'How long client-side caches stay fresh before forcing a server refetch on next read. Default 24h.',
      min: 0.01,
      max: 168,
      default: 24,
      group: 'Cache',
    },
    {
      key: 'cacheHardCutoffHours',
      type: 'number',
      label: 'Hard Cutoff (hours)',
      description: 'How long the client may run with no successful server contact before entering read-only mode. Mutations are refused until contact resumes. Default 24h.',
      min: 0.01,
      max: 168,
      default: 24,
      group: 'Lockout',
    },
  ],
};
