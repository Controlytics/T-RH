import { prisma } from '../../lib/prisma.js';
import { coerceApproverRoles, REPORT_APPROVERS_CONFIG_KEY } from '@digilog/shared';

/**
 * The administered approver roles (Configuration → Report Approvers,
 * 2026-09-07). Through the shared coercer, so the request check here, the
 * narrow-slice route and the browser's picker read one row one way.
 *
 * **An absent row is an EMPTY list — fail closed, like `loadInactivityConfig`
 * and unlike `loadLimitConfig`.** Failing open would let a report be sent to
 * any role at all, which is exactly the state the operator asked to end.
 */
export async function loadApproverRoles(): Promise<string[]> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: REPORT_APPROVERS_CONFIG_KEY } });
  return coerceApproverRoles(row?.configValue);
}
