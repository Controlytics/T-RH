/**
 * The Report Templates page's wire helpers. A template row is the SHARED
 * `ReportTemplateRow` (`@digilog/shared`: `kind`, `profileId: string | null`
 * — null for an application-wide kind), read through
 * `coerceReportTemplateDocument`, the ONE forgiving reader; the page keeps no
 * second definition of it (2026-11-03, page reports on templates).
 *
 * The URL builders are the ONE pair every caller uses — this page and every
 * download dialog's plan (`lib/report-template-plan.ts`, where they live):
 * `?kind=` always, `profileId` only for a profile-scoped kind.
 */
export { reportTemplatesCatalogueUrl, reportTemplatesListUrl } from '@/lib/report-template-plan';

export interface ReportTemplateProfile {
  id: string;
  name: string;
  instrumentCount?: number;
}
