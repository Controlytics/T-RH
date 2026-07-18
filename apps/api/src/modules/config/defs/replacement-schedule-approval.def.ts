import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Replacement Schedule Workflow role assignment (2026-06-11). Mirrors
 * pm-schedule-approval. Each field that is left blank/unset INHERITS the
 * matching PM Schedule Workflow setting (see getReplacementWorkflowConfig) —
 * so existing installs that relied on the shared PM config keep working until
 * an admin sets a Replacement-specific role here. This avoids silently
 * loosening who may review/approve replacement schedules (21 CFR §11).
 */
export const replacementScheduleApprovalDef: ModuleConfigDefinition = {
  moduleKey: 'replacement-schedule-approval',
  moduleName: 'Replacement Schedule Workflow',
  description: 'Configure the upload → review → approve workflow for replacement schedules: which role performs each step. Leave a field blank to inherit the PM Schedule Workflow setting. Super Admin can always perform any step.',
  icon: 'clipboard-check',
  category: 'filter-management',
  sortOrder: 62,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'workflowEnabled',
      type: 'boolean',
      label: 'Enable Review + Approval Workflow',
      description: 'When ON, an uploaded replacement schedule must be reviewed and then approved before its entries become due tasks. When OFF, uploads are auto-approved. Leave unset to inherit the PM Schedule Workflow toggle.',
      group: 'Workflow',
      // No default on purpose: an unseeded (absent) value inherits the PM
      // toggle in getReplacementWorkflowConfig, so enabling the RS workflow is
      // never silently turned OFF for installs that relied on the shared PM
      // config. Explicitly toggling here stores a boolean that overrides.
    },
    {
      key: 'uploadRole',
      type: 'select',
      label: 'Upload Role',
      description: 'Role allowed to upload replacement schedules. Blank = inherit PM (or anyone with the upload permission if PM is also blank). Super Admin can always upload.',
      group: 'Workflow',
      default: '',
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
    {
      key: 'reviewRole',
      type: 'select',
      label: 'Review Role',
      description: 'Role allowed to review an uploaded replacement schedule (modify or reject before approval). Blank = inherit PM. Super Admin can always review.',
      group: 'Workflow',
      default: '',
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
    {
      key: 'approvalRole',
      type: 'select',
      label: 'Approval Role',
      description: 'Role allowed to approve (or reject) a reviewed replacement schedule. Blank = inherit PM. Super Admin can always approve.',
      group: 'Workflow',
      default: '',
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
  ],
};
