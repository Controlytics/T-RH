import { z } from 'zod';
import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';
import { AUDIT_HARD_DELETE_CONFIG_KEY } from '../../../lib/audit-immutability.js';

/**
 * Audit Hard Delete (2026-10-12; operator decision on audit 2026-10-03 DATA-8 /
 * 2026-08-29 H3).
 *
 * Whether `DELETE /api/audit/:id` and `POST /api/audit/bulk-delete` — the one
 * place in the product where §11 history is DESTROYED rather than redacted —
 * are available at all. Until this date that was the `AUDIT_HARD_DELETE_ENABLED`
 * environment variable, which defaulted to ENABLED when absent; the operator
 * asked for an on/off toggle in Configuration instead, default OFF. The env var
 * is no longer read.
 *
 * Read by `isHardDeleteEnabled()` (lib/audit-immutability.ts) on every request,
 * `enabled === true` only — an absent, half-seeded or hand-edited row is OFF.
 * SUPER_ADMIN only; every change is a CONFIG_CHANGED audit row through the
 * generic dynamic PUT, and re-authentication is governed by the
 * `UPDATE_AUDIT_HARD_DELETE` entry under Action Re-authentication.
 *
 * Whatever this says, the meta rows that RECORD a deletion or a redaction can
 * never be hard-deleted (audit 2026-10-12 #6) — see `PROTECTED_AUDIT_ACTIONS`.
 */

export const auditHardDeleteDef: ModuleConfigDefinition = {
  moduleKey: AUDIT_HARD_DELETE_CONFIG_KEY,
  moduleName: 'Audit Hard Delete',
  description: 'Whether audit records can be permanently deleted. Off by default; redaction is always available and keeps the hash chain intact.',
  icon: 'trash',
  category: 'security',
  sortOrder: 28,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: 'SUPER_ADMIN',
  requiresReauth: false,
  reauthAction: 'UPDATE_AUDIT_HARD_DELETE',
  hasCustomPage: false,
  settings: [
    {
      key: 'enabled',
      type: 'boolean',
      label: 'Allow permanent deletion of audit records',
      description: 'When on, a user holding the Delete Audit Records permission can PHYSICALLY delete audit records. Deletion breaks the tamper-evident hash chain at that point for good, and Verify Chain will report it. When off, deletion is refused and Redact — which removes the record\'s content but keeps the chain intact — is the only way to withdraw a record. The records that document a deletion or a redaction can never be deleted, whatever this says.',
      default: false,
      group: 'Audit Hard Delete',
    },
  ],
  zodSchema: z.object({ enabled: z.boolean() }).strict(),
};
