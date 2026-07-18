import useSWR from 'swr';
import { resolveReportLabels, type ReportLabelsConfig, type ResolvedReportLabels } from '../lib/report-labels';

/**
 * Fetches the admin report-label overrides (systemConfig key 'report-labels')
 * and returns a resolver. A report calls `labelsFor('cleaning-cycles')` to get
 * its title / subtitle / column labels (overrides merged over built-in defaults).
 * Network failure ⇒ defaults (the resolver works with an empty config).
 */
export function useReportLabels(): {
  config: ReportLabelsConfig;
  labelsFor: (reportKey: string) => ResolvedReportLabels;
  isLoading: boolean;
} {
  const { data, isLoading } = useSWR<ReportLabelsConfig>('/api/config/report-labels/current');
  const config = (data ?? {}) as ReportLabelsConfig;
  return {
    config,
    labelsFor: (reportKey: string) => resolveReportLabels(reportKey, config),
    isLoading,
  };
}
