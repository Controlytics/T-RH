import { prisma } from '../../lib/prisma.js';
import { coerceReportDownloads, REPORT_DOWNLOADS_CONFIG_KEY, type ReportDownloadsPolicy } from '@digilog/shared';

/**
 * How each report type downloads (Configuration → Report Downloads,
 * 2026-10-01). An absent row reads as today's behaviour for every kind —
 * Request, remarks and password required — through the ONE coercer.
 */
export async function loadReportDownloads(): Promise<ReportDownloadsPolicy> {
  const row = await prisma.systemConfig.findUnique({ where: { configKey: REPORT_DOWNLOADS_CONFIG_KEY } });
  return coerceReportDownloads(row?.configValue);
}
