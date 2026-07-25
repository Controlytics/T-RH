import { resolveReportLabels, type ReportLabelsConfig, type ResolvedReportLabels } from '../lib/report-labels';

/**
 * Returns a report-label resolver. A report calls `labelsFor('audit-trail')` to
 * get its title / subtitle / column labels.
 *
 * This used to fetch admin overrides from the systemConfig key 'report-labels'.
 * That config def was dropped in the Phase 0 domain strip (only
 * `report-page-titles.def.ts` survives), so `GET /api/config/report-labels/current`
 * 404'd on every report page. The resolver already handled an empty config by
 * returning built-in defaults, which is exactly what the 404 path produced — so
 * resolving straight from defaults is behaviour-preserving and drops the failed
 * request. Restore the fetch here if a report-labels config def is ever re-added.
 */
const EMPTY_CONFIG: ReportLabelsConfig = {};

export function useReportLabels(): {
  config: ReportLabelsConfig;
  labelsFor: (reportKey: string) => ResolvedReportLabels;
  isLoading: boolean;
} {
  return {
    config: EMPTY_CONFIG,
    labelsFor: (reportKey: string) => resolveReportLabels(reportKey, EMPTY_CONFIG),
    isLoading: false,
  };
}
