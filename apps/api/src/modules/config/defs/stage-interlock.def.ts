import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Cleaning Stage Interlock — two-point QA approval gate inside a cleaning cycle.
 *
 * After WASH_OUT and after DRY_OUT the cycle pauses and routes the filter's
 * frozen context to a configurable approver role for a re-authenticated
 * (digital-signature) decision. Approve → continue per the cleaning-profile
 * graph; Reject → state moves back (WASH_OUT→WASH_IN, DRY_OUT→DRY_IN).
 *
 * Reject targets are fixed by spec, so they are NOT configurable here — they
 * live in the stage-approvals service (STAGE_INTERLOCK_POINTS). Only the
 * enable toggle, segregation-of-duties flag, and per-stage approver role are
 * operator-configurable.
 *
 * Read by stage-approvals + filter-operations (advance/bypass gate).
 */
export const stageInterlockDef: ModuleConfigDefinition = {
  moduleKey: 'stage-interlock',
  moduleName: 'Cleaning Stage Interlock',
  description: 'Require a QA approval signature after Wash Out and after Dry Out before a filter can continue cleaning',
  icon: 'shield-check',
  category: 'filter-management',
  sortOrder: 61,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Enable Stage Interlock',
      description: 'When ON, completing Wash Out and Dry Out pauses the cycle and requires an approver to verify the filter details and sign off before the operator can advance to the next stage.',
      group: 'General',
      default: false,
    },
    {
      key: 'requireDifferentApprover',
      type: 'boolean',
      label: 'Require a Different Approver',
      description: 'The operator who performed the cleaning cannot approve their own stage (segregation of duties). Strongly recommended for 21 CFR Part 11.',
      group: 'General',
      default: true,
    },
    {
      key: 'washOutApproverRole',
      type: 'select',
      label: 'Wash Out Approver Role',
      description: 'Only users with this role (plus Super Admin) can approve the interlock after Wash Out completes.',
      group: 'Approver Roles',
      default: 'ADMIN',
      // Loaded live from the roles table so newly created roles appear immediately.
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
    {
      key: 'dryOutApproverRole',
      type: 'select',
      label: 'Dry Out Approver Role',
      description: 'Only users with this role (plus Super Admin) can approve the interlock after Dry Out completes.',
      group: 'Approver Roles',
      default: 'ADMIN',
      dynamicOptionsSource: '/api/roles/active',
      options: [],
    },
  ],
};
