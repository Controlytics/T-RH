import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

export const blockChangeApprovalDef: ModuleConfigDefinition = {
  moduleKey: 'block-change-approval',
  moduleName: 'Cross-Block Cleaning',
  description: 'Choose how cleaning a filter in a block other than its home block is handled',
  icon: 'shield-check',
  category: 'filter-management',
  sortOrder: 60,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'mode',
      type: 'select',
      label: 'Cross-Block Mode',
      description: 'NONE = no cross-block check at all — any filter can be cleaned in any block with nothing shown or asked. CONFIRM = operator self-confirms ("Continue with cleaning?") and proceeds. APPROVAL = operator submits a block-change request that an approver must approve before cleaning. For CONFIRM/APPROVAL, OFFLINE never blocks — it shows an informational notice and proceeds.',
      group: 'Mode',
      default: 'CONFIRM',
      options: [
        { value: 'NONE', label: 'None (no restriction — clean any block freely)' },
        { value: 'CONFIRM', label: 'Block confirmation (operator self-confirm)' },
        { value: 'APPROVAL', label: 'Block change request (needs approval)' },
      ],
    },
    {
      key: 'approvalRole',
      type: 'select',
      label: 'Approval Role',
      description: 'Only users with this role can approve block change requests. Super Admin can always approve regardless of this setting.',
      group: 'Approval',
      default: 'ADMIN',
      // Loaded live from the roles table so newly created roles appear immediately
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
    {
      key: 'requireReason',
      type: 'boolean',
      label: 'Require Reason',
      description: 'Require users to provide a reason when requesting a block change',
      group: 'Approval',
      default: true,
    },
    {
      key: 'autoExpireHours',
      type: 'number',
      label: 'Auto-Expire Hours',
      description: 'Approved requests expire after this many hours (0 = no expiry)',
      group: 'Approval',
      default: 24,
    },
  ],
};
