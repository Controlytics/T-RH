import useSWR from 'swr';
import { useBranding } from './use-branding';

/**
 * Report identity shown on every report's on-screen page view (ReportPageWrapper)
 * header + footer: company name and application name. Configured at
 * Config → Report Page Titles; blank → fall back to the global Branding value.
 * The logo always comes from Branding. (The former configurable common labels
 * were removed 2026-06-29; the report chrome uses fixed defaults now.)
 */
type StoredReportIdentity = { companyName?: string; appName?: string };

export function useReportPageTitles() {
  const { data } = useSWR<StoredReportIdentity>(
    '/api/config/report-page-titles/current',
    { revalidateOnFocus: false, dedupingInterval: 10000 },
  );
  const { branding } = useBranding();

  const companyName = data?.companyName?.trim() || branding.companyName;
  const appName = data?.appName?.trim() || branding.appName;

  return { branding, companyName, appName };
}
