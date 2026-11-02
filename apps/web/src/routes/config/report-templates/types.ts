import type { WidgetType } from '@digilog/shared';

/**
 * One `report_templates` row as `GET /api/report-templates` serves it
 * (plan Task 2). `document` is typed `unknown` on purpose: it is read through
 * `coerceReportTemplateDocument`, the ONE forgiving reader, never trusted as is.
 */
export interface ReportTemplateRow {
  id: string;
  profileId: string;
  widgetType: WidgetType;
  name: string;
  isDefault: boolean;
  document: unknown;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface ReportTemplateProfile {
  id: string;
  name: string;
  instrumentCount?: number;
}

export const reportTemplatesListUrl = (profileId: string, widgetType: WidgetType) =>
  `/api/report-templates?profileId=${encodeURIComponent(profileId)}&widgetType=${encodeURIComponent(widgetType)}`;

export const reportTemplatesCatalogueUrl = (profileId: string, widgetType: WidgetType) =>
  `/api/report-templates/catalogue?profileId=${encodeURIComponent(profileId)}&widgetType=${encodeURIComponent(widgetType)}`;
