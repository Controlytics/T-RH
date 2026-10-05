import { describe, it, expect } from 'vitest';
import { AUDIT_ACTIONS } from './audit-actions.js';
import { AUDIT_TEMPLATE_DEFAULTS } from './audit-templates.js';

/**
 * The action registry and the template defaults are two halves of one
 * vocabulary (audit 2026-10-03, DATA-10): an action with no template renders
 * as its raw name in the Audit Trail and in the exported §11 record; a
 * template with no action is a row in the editor for an event that can never
 * happen. Each side is pinned here. The API-side companion,
 * `apps/api/src/lib/__tests__/audit-actions-registry.test.ts`, pins every
 * `action: '…'` the API writes to this registry.
 */

/**
 * Template keys that are deliberately NOT actions. The renderer
 * (`apps/web/src/routes/audit/audit-helpers.ts`) tries `<action>_SELF` when
 * the actor is the target, and falls back to the generic verbs when an action
 * has no template of its own; `LOGIN` is the pre-2026-05 name of
 * `LOGIN_SUCCESS` and historic rows may carry it. Anything else listed here
 * has NO writer and no stored row in either local database as of 2026-10-05
 * — kept only because an operator-customised template row may still name
 * it; a candidate for removal, not a precedent for adding more.
 */
const TEMPLATE_ONLY_KEYS = new Set([
  // self-action variants
  'USER_UPDATED_SELF', 'PASSWORD_CHANGED_SELF', 'PROFILE_UPDATED_SELF',
  // generic verb fallbacks
  'CREATED', 'UPDATED', 'DELETED', 'ASSIGNED', 'ARCHIVED',
  // historic action name
  'LOGIN',
  // no writer, no stored row (measured 2026-10-05)
  'ADMIN_REQUEST_APPROVED', 'ADMIN_REQUEST_REJECTED', 'REPORT_REVIEW_SUBMITTED', 'GRANT_OFFLINE_REPLAY',
]);

describe('AUDIT_ACTIONS ↔ AUDIT_TEMPLATE_DEFAULTS', () => {
  it('every key is its own value — the enum is a controlled vocabulary of names', () => {
    for (const [key, value] of Object.entries(AUDIT_ACTIONS)) {
      expect(value, key).toBe(key);
    }
  });

  it('every registered action has a default template', () => {
    const missing = Object.keys(AUDIT_ACTIONS).filter((k) => !AUDIT_TEMPLATE_DEFAULTS[k]);
    expect(missing).toEqual([]);
  });

  it('every template is for a registered action, or a documented renderer variant', () => {
    const stray = Object.keys(AUDIT_TEMPLATE_DEFAULTS)
      .filter((k) => !(k in AUDIT_ACTIONS) && !TEMPLATE_ONLY_KEYS.has(k));
    expect(stray).toEqual([]);
  });

  it('carries none of the names pruned on 2026-10-05 — they have no writer in the tree', () => {
    const pruned = [
      'ROLE_ASSIGNED', 'SESSION_TIMEOUT', 'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_REJECTED',
      'STAGE_APPROVAL_APPROVED', 'STAGE_APPROVAL_REJECTED', 'STAGE_APPROVAL_SUPERSEDED',
      'DATA_VIEWED', 'DATA_EXPORTED', 'DATA_ATTRIBUTES_UPDATED', 'DATA_ARCHIVED',
      'UNAUTHORIZED_ACTION_ATTEMPT', 'ALARM_CREATED', 'ALARM_CLEARED', 'ALARM_ESCALATED',
      'SEPARATION_OF_DUTIES_DISABLED', 'RULE_CHAIN_CREATED', 'RULE_CHAIN_UPDATED', 'RULE_CHAIN_DELETED',
      'RULE_CHAIN_SET_ROOT', 'RULE_CHAIN_IMPORTED', 'DEVICE_CREDENTIAL_REGENERATED',
      'UNS_PATH_OVERRIDDEN', 'UNS_CONFIG_UPDATED', 'RETENTION_POLICY_UPDATED',
      'SYSTEM_CONFIG_UPDATED', 'SERVER_RESTART_TRIGGERED',
    ];
    expect(pruned).toHaveLength(28);
    for (const name of pruned) {
      expect(name in AUDIT_ACTIONS, name).toBe(false);
      expect(AUDIT_TEMPLATE_DEFAULTS[name], name).toBeUndefined();
    }
  });

  it('the eleven actions the API wrote without registering are registered now', () => {
    for (const name of [
      'AUDIT_RECORD_REDACTED', 'AUDIT_RECORDS_BULK_REDACTED', 'ROLE_CREATED', 'ROLE_UPDATED', 'ROLE_DELETED',
      'ADMIN_REQUEST_SUBMITTED', 'LDAP_CONFIG_UPDATED', 'SUPER_ADMIN_API_ACCESS_CHANGED',
      'UPDATE_EMAIL_CONFIG', 'UPDATE_SMS_CONFIG', 'DASHBOARD_CREATED',
    ]) {
      expect(AUDIT_ACTIONS[name as keyof typeof AUDIT_ACTIONS], name).toBe(name);
    }
  });
});
