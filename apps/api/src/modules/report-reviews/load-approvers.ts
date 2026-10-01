import { prisma } from '../../lib/prisma.js';
import { coerceReportApprovers, REPORT_APPROVERS_CONFIG_KEY, type ReportApproversConfig } from '@digilog/shared';

/**
 * The administered approvers (Configuration → Report Approvers): roles since
 * 2026-09-07, users named outright since 2026-10-01. Through the shared coercer,
 * so the request check here, the narrow-slice route and the browser read one
 * row one way.
 *
 * **An absent row is EMPTY — fail closed, like `loadInactivityConfig` and
 * unlike `loadLimitConfig`.** Failing open would let a report reach approvers
 * nobody appointed.
 */
export async function loadReportApprovers(): Promise<ReportApproversConfig> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: REPORT_APPROVERS_CONFIG_KEY } });
  return coerceReportApprovers(row?.configValue);
}
