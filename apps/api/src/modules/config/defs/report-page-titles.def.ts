import type { ModuleConfigDefinition } from '../../../lib/config-registry.js';

/**
 * Report Page Titles — the report identity (company name + application name)
 * shown in the header AND footer of every report's on-screen page view
 * (rendered by the shared ReportPageWrapper chrome). Blank values fall back to
 * the global Branding config; the logo always comes from Branding.
 *
 * Report-SPECIFIC titles/subtitles/columns live in "Report Labels" — not here.
 * PDF exports read the same override: `loadBranding` (apps/web/src/lib/pdf-report.ts)
 * fetches this row's company / app name over Branding for every PDF header and footer, and
 * a report drawn from a template uses the template's own names first (a template with
 * none falls back to this override, then Branding).
 *
 * Replaces the former "Report Settings" config (show/hide toggles + layout),
 * removed 2026-06-29. The configurable common labels (performed-by / record-count
 * / pagination) were also removed 2026-06-29 — the chrome uses fixed defaults.
 */
export const reportPageTitlesDef: ModuleConfigDefinition = {
  moduleKey: 'report-page-titles',
  moduleName: 'Report Page Titles',
  description: 'Set the company name & application name shown in every report header and footer',
  icon: 'file-text',
  category: 'display',
  sortOrder: 12,
  permissions: { read: 'CONFIG_READ', write: 'CONFIG_UPDATE' },
  requiredRole: null,
  requiresReauth: false,
  hasCustomPage: true,
  customPagePath: '/config/report-page-titles',
  settings: [],
};
