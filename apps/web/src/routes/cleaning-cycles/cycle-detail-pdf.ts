import { fmtMinutes } from '../../lib/cleaning-cycle-report';
import { STAGE_LABELS } from './cycle-detail-view';

/**
 * Append one cleaning cycle's full detail (summary key-values + stage progress
 * table + event timeline table + checklist Q&A tables) to a report created by
 * createReport(). Shared by the View detail PDF (timeline.tsx) and the Filter
 * Lifecycle Report PDF so both render identically. `report` is the ReportDoc
 * returned by createReport(); typed loosely to avoid importing the type.
 */
export function appendCycleDetailToReport(
  report: any,
  cycle: any,
  fmt: { formatDateTime: (s: string) => string },
) {
  const { formatDateTime } = fmt;
  const events = cycle.events ?? [];

  // "Duration" = dryer duration selected at DRY_IN, not total cycle duration.
  const dryerEvent = events.find((e: any) =>
    e.eventType === 'STATE_TRANSITION' && e.toState === 'DRY_IN' &&
    (e.attributes?.action === 'DRYER_STARTED' || e.attributes?.dryerDurationMinutes != null));
  const dryerMinutes: number | null =
    cycle.dryerDurationMinutes ?? dryerEvent?.attributes?.dryerDurationMinutes ?? null;
  const durationStr = fmtMinutes(dryerMinutes) ?? '—';

  const completedStages = events
    .filter((e: any) => e.eventType === 'STATE_TRANSITION' && e.toState)
    .map((e: any) => e.toState);

  // Summary key-values
  report.addKeyValue([
    ['Cleaning Reason', cycle.cleaningReasonLabel || cycle.cleaningReasonKey || '-'],
    ['Block', cycle.cleaningAreaName ?? '-'],
    ['Duration', durationStr],
    ['Started', formatDateTime(cycle.startedAt)],
    ['Completed', cycle.completedAt ? formatDateTime(cycle.completedAt) : 'In Progress'],
    ['Events', `${events.length} event(s)`],
  ]);

  // Stage progress
  report.addSectionTitle('Stage Progress');
  const allStages = ['WASH_IN', 'WASH_OUT', 'DRY_IN', 'DRY_OUT', 'STORAGE_IN', 'STORAGE_OUT'];
  report.addTable({
    head: allStages.map((s) => STAGE_LABELS[s] ?? s),
    body: [allStages.map((s) => completedStages.includes(s) ? 'Done' : 'Pending')],
    headColor: [59, 130, 246],
  });

  // Events
  report.addSectionTitle('Event Timeline');
  const eventRows: string[][] = [];
  const checklistRows: { eventIdx: number; qa: { question: string; answer: any }[] }[] = [];

  events.forEach((ev: any, idx: number) => {
    eventRows.push([
      String(idx + 1),
      ev.eventType.replace(/_/g, ' '),
      ev.fromState
        ? (STAGE_LABELS[ev.fromState] ?? ev.fromState)
        : (ev.eventType === 'STATE_TRANSITION' && ev.toState ? 'To Be Cleaned' : '-'),
      ev.toState ? (STAGE_LABELS[ev.toState] ?? ev.toState) : '-',
      ev.performedByName ?? '-',
      formatDateTime(ev.performedAt),
      ev.remarks || '-',
    ]);
    if (ev.enrichedAnswers?.length > 0) {
      checklistRows.push({ eventIdx: idx + 1, qa: ev.enrichedAnswers });
    }
  });

  report.addTable({
    head: ['S.No', 'Event', 'From', 'To', 'Performed By', 'Time', 'Remarks'],
    body: eventRows,
    columnStyles: { 0: { cellWidth: 14, halign: 'center' }, 6: { cellWidth: 50 } },
  });

  // Checklist answers
  for (const cl of checklistRows) {
    report.addSectionTitle(`Checklist Responses (S.No ${cl.eventIdx})`);
    const qaRows = cl.qa.map((qa, i) => [
      String(i + 1),
      qa.question,
      typeof qa.answer === 'boolean' ? (qa.answer ? 'Yes' : 'No') : String(qa.answer),
    ]);
    report.addTable({
      head: ['S.No', 'Question', 'Answer'],
      body: qaRows,
      headColor: [21, 128, 61],
      columnStyles: { 0: { cellWidth: 14, halign: 'center' }, 2: { cellWidth: 30 } },
    });
  }
}
