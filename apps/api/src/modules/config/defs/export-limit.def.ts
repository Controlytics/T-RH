import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { EXPORT_LIMIT_HARD_CEILING, EXPORT_LIMIT_DEFAULT_MAX, EXPORT_LIMIT_DEFAULT_MESSAGE } from '@digilog/shared';

// Export size guardrail. Client-side PDF/Excel generation OOMs the browser past
// tens of thousands of rows, so every export button blocks first and shows the
// message below. `maxRecords` is the SOFT limit (admin-tunable); the hard
// ceiling is enforced in the zod schema (`exportLimitConfigSchema.max`).
export const exportLimitDef: ModuleConfigDefinition = {
  moduleKey: 'export-limit',
  moduleName: 'Export Limits',
  description: 'Maximum records allowed in a single report/export, and the message shown when that limit is exceeded.',
  icon: 'download',
  category: 'display',
  sortOrder: 13,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'maxRecords',
      type: 'number',
      label: 'Maximum Export Records',
      description: `Block any PDF/Excel export with more rows than this. Cannot exceed ${EXPORT_LIMIT_HARD_CEILING.toLocaleString()} (the safety ceiling — larger exports crash the browser).`,
      default: EXPORT_LIMIT_DEFAULT_MAX,
      min: 1,
      max: EXPORT_LIMIT_HARD_CEILING,
      group: 'Export Limits',
    },
    {
      key: 'message',
      type: 'textarea',
      label: 'Message When Exceeded',
      description: 'Shown to the user when an export is blocked. Use {count} for the number of rows they tried to export and {max} for the current limit.',
      default: EXPORT_LIMIT_DEFAULT_MESSAGE,
      maxLength: 500,
      group: 'Export Limits',
    },
  ],
};
