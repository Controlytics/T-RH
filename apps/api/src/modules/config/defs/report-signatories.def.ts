import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Report Signatories (2026-06-11). Role × report MATRIX (like Export Options):
 * for each report and role the admin picks the signature label (Printed By /
 * Reviewed By / Approved By). The generator's role + the report decide the
 * label; the value is always that user's User ID. Stored shape:
 *   { [roleName]: { [reportKey]: label } }
 */
export const reportSignatoriesDef: ModuleConfigDefinition = {
  moduleKey: 'report-signatories',
  moduleName: 'Report Signatories',
  description: 'Per report and role, choose the signature label (Printed By / Reviewed By / Approved By) shown with the User ID',
  icon: 'pencil',
  category: 'display',
  sortOrder: 13,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/report-signatories',
  settings: [],
};
