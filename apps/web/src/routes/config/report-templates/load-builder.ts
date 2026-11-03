import type { buildTemplatedReport } from '@/lib/templated-report';

export type BuildTemplatedReport = typeof buildTemplatedReport;

/**
 * The templated report builder (`lib/templated-report.ts`) — the same code
 * every download of every kind runs, widget or page report — loaded on first
 * use.
 *
 * Two reasons it is a seam of its own: jsPDF stays out of this page's chunk
 * until a preview is actually drawn, and the page's tests replace THIS module
 * rather than the builder — what they pin is when and with what the preview
 * calls it, not how a PDF is drawn (the builder has its own tests).
 */
export function loadBuildTemplatedReport(): Promise<BuildTemplatedReport> {
  return import('@/lib/templated-report').then((m) => m.buildTemplatedReport);
}
