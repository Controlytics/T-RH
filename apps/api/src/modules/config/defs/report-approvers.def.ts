import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Which roles may APPROVE a report (2026-09-07).
 *
 * Operator: "that approval role should be configurable which role user should
 * be approved that role will set by super admin in configurations". Every PDF
 * download is a request an approver signs (the report review workflow); this is
 * where SUPER_ADMIN says which roles those approvers hold. The request dialog's
 * Send-to list narrows to these roles and the enabled users holding one, and the
 * SERVER refuses a request sent anywhere else — the dialog is presentation.
 *
 * **Ships EMPTY, and empty means nothing may be requested.** Failing closed is
 * the §11 stance: a report must not reach an approver nobody appointed. The
 * consequence is real and is stated on the setting — after deploy no PDF can be
 * requested until this is set once. `coerceApproverRoles` in `@digilog/shared`
 * is the one reader; SUPER_ADMIN is never an approver even if ticked here.
 *
 * Renders through the dynamic config page (no `routes/config/*.tsx`), with the
 * role list loaded live from `/api/roles/active` — the `dynamicOptionsSource`
 * mechanism, which existed but had no def using it until now.
 */
export const reportApproversDef: ModuleConfigDefinition = {
  moduleKey: 'report-approvers',
  moduleName: 'Report Approvers',
  description: 'Which roles may approve a report request. A report can only be sent to one of these roles, or to a user holding one.',
  icon: 'check-badge',
  category: 'system',
  sortOrder: 24,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'approverRoles',
      type: 'multiselect',
      label: 'Approver roles',
      description:
        'Roles whose holders may approve report requests. Requesters can send a report only to one of these roles, or to a user who holds one. With none ticked, NO report can be requested until this is set — the workflow fails closed. Super Admin is never an approver.',
      default: [],
      options: [],
      dynamicOptionsSource: '/api/roles/active',
      group: 'Report Approvers',
    },
  ],
};
