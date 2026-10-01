import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Which roles — and, since 2026-10-01, which users — may APPROVE a report.
 *
 * Since 2026-10-01 the requester chooses nobody: a request goes to every
 * configured role and user, frozen onto the request (operator: "per user or
 * per role option should be removed in request place and add that in
 * configuration"). What follows about the Send-to list is history.
 *
 * Roles since 2026-09-07.
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
  description: 'Who approves report requests: every holder of a ticked role and every ticked user. A request goes to all of them; any one may approve.',
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
        'Every user holding one of these roles may approve report requests, and sees them. With no role and no user ticked, NO report can be requested — the workflow fails closed. Super Admin is never an approver role.',
      default: [],
      options: [],
      dynamicOptionsSource: '/api/roles/active',
      group: 'Report Approvers',
    },
    {
      // 2026-10-01: users named outright, beside the roles. Ids; the options
      // come from a narrow route that labels each one "username (role)".
      key: 'approverUserIds',
      type: 'multiselect',
      label: 'Approver users',
      description:
        'Users who may approve report requests whatever their role, and see them. A request goes to every approver role and every approver user at once; a later change here does not re-route a request already raised.',
      default: [],
      options: [],
      dynamicOptionsSource: '/api/config/report-approvers/candidates',
      group: 'Report Approvers',
    },
  ],
};
