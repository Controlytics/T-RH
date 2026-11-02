import type { buildWidgetReport } from '@/lib/widget-report';

export type BuildWidgetReport = typeof buildWidgetReport;

/**
 * The widget report builder (`lib/widget-report.ts`), loaded on first use.
 *
 * Two reasons it is a seam of its own: jsPDF stays out of this page's chunk
 * until a preview is actually drawn, and the page's tests replace THIS module
 * rather than the builder — what they pin is when and with what the preview
 * calls it, not how a PDF is drawn (the builder has its own tests).
 */
export function loadBuildWidgetReport(): Promise<BuildWidgetReport> {
  return import('@/lib/widget-report').then((m) => m.buildWidgetReport);
}
