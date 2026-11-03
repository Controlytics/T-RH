/**
 * A dashboard widget's "Download report" (2026-11-02) — spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §7-§8.
 *
 * The governed `ReportDownloadDialog`, kind `widget:<type>` (Direct or Request
 * per Configuration → Report Settings), with what the report will be printed
 * with above its fields: per instrument profile, the template the SERVER
 * resolved ("Template: <name> (<profile>)", or "Built-in"), a picker when the
 * profile has more than one, and — for a SUPER_ADMIN — the way to the editor.
 * Those lines are `components/report-template-lines.tsx` and the plan behind
 * them `lib/report-template-plan.ts` (2026-11-03), the SAME two every page's
 * download dialog uses; this dialog adds only the widget's one-section rule.
 *
 * On confirm: the widget's data for the dialog's period (`collectWidgetReport`,
 * the widget's own fetchers), split into its profiles' sections, printed by
 * the ONE builder (`lib/widget-report.ts`), every cap and missing picture said
 * under it, then `deliverReport` — the ONE path a report leaves a page by — and
 * its toast. The builder and the delivery carry jsPDF and are imported on
 * confirm, so the dashboard's main bundle never carries them.
 *
 * A present-state widget has no period: it prints `{period}` as "Latest" and
 * `{from}` / `{to}` as "—" (ruling T1-C2) and sends NO period to the server —
 * "—" is a placeholder in the PDF, never a date on the wire.
 */
import { useMemo, useState } from 'react';
import {
  DEFAULT_PERIOD, PERIOD_PRESETS, WIDGET_REPORT_FIELDS, WIDGET_REPORT_KIND, WIDGET_TYPE_SPECS,
  builtinReportTemplate, coerceReportTemplateDocument, widgetReportType,
  type CustomWidget, type Placeholder, type ReportTemplateDocument, type ReportTemplateRow,
} from '@digilog/shared';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { ReportTemplateLines } from '@/components/report-template-lines';
import { chooseTemplate, planScopeKey } from '@/lib/report-template-plan';
import type { WidgetReportSection } from '@/lib/widget-report';
import { useAuth } from '@/hooks/use-auth';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useSensorWords } from '@/hooks/use-failure-text';
import { useToast } from '@/hooks/use-toast';
import { EMPTY_WIDGET_FILTERS } from '@/routes/alarms/alarm-widget-filters';
import { useAlarmDisplayTexts } from '../selection-alarms';
import type { WidgetSelection } from './use-widget-data';
import { useWidgetReportViewRegistry } from './widget-report-view';
import { BAR_DEFAULTS } from './bar-chart-model';
import { collectWidgetReport, reportRefs, sectionRows, useWidgetReportPlan } from './widget-report-data';

/** Said when the server resolves a widget's templates with no profile on a section (a widget type is profile-scoped). */
export const UNPROFILED_MESSAGE = 'The server named no instrument profile for some of this widget\'s instruments, so the report cannot be printed. Close this and try again.';

/** `POST /api/report-reviews` caps the title and the subtitle at these lengths. */
const REQUEST_TITLE_MAX = 500;
const REQUEST_SUBTITLE_MAX = 1000;

/** At most `max` characters, an ellipsis saying where it was cut. */
export function clampText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export interface WidgetReportDialogProps {
  open: boolean;
  widget: CustomWidget;
  selection: WidgetSelection;
  /** What `{dashboard}` prints: the built dashboard's name, or "Dashboard" on `/`. */
  dashboardTitle: string;
  /** What `{selection}` prints: the dashboard's drill-down or source, as its header says it. */
  selectionLabel: string;
  onClose: () => void;
}

export function WidgetReportDialog(props: WidgetReportDialogProps) {
  // Mounted only while open: its hooks ask nothing for a closed dialog.
  return props.open ? <OpenWidgetReportDialog {...props} /> : null;
}

/** One section of the report as chosen: its profile, its instruments, the template picked. */
interface ChosenSection {
  profileId: string;
  profileName: string;
  instrumentIds: string[];
  availableIds: string[];
  /** The template row printed with, or null = the built-in. */
  template: ReportTemplateRow | null;
  document: ReportTemplateDocument;
}

/**
 * Whether the widget's report is ONE section for all its instruments — no row
 * of it names a single instrument, so it cannot be split by profile: the text
 * card, the floor plan, the pie, the alarm counts, the bars of every
 * instrument combined.
 */
export function printsOneTable(widget: CustomWidget): boolean {
  return widget.type === 'text_card' || widget.type === 'floorplan' || widget.type === 'pie_chart' || widget.type === 'alarm_counts'
    || (widget.type === 'bar_chart' && (widget.options.groupBy ?? BAR_DEFAULTS.groupBy) === 'all');
}

function OpenWidgetReportDialog({ widget, selection, dashboardTitle, selectionLabel, onClose }: WidgetReportDialogProps) {
  const type = widget.type;
  const windowed = WIDGET_TYPE_SPECS[type].followsWindow;
  const registry = useWidgetReportViewRegistry();
  // What the widget is showing, read ONCE as the dialog opens.
  const [view] = useState(() => registry?.read(widget.id) ?? {});
  const plan = useWidgetReportPlan(widget, selection);
  const [picks, setPicks] = useState<Record<string, string>>({});
  const words = useSensorWords();
  const alarm = useAlarmDisplayTexts();
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const { user } = useAuth();
  const { toast } = useToast();
  const superAdmin = user?.role === 'SUPER_ADMIN';

  const [initialPeriod] = useState(() => {
    if (view.range) return { from: view.range.from, to: view.range.to, label: 'Widget period' };
    const ms = (PERIOD_PRESETS.find((p) => p.value === (widget.options.period ?? DEFAULT_PERIOD))
      ?? PERIOD_PRESETS.find((p) => p.value === DEFAULT_PERIOD)!).ms;
    const to = Math.ceil(Date.now() / 60_000) * 60_000;
    return { from: new Date(to - ms).toISOString(), to: new Date(to).toISOString(), label: 'Widget period' };
  });

  /**
   * The report's sections. A text card covers no instrument: ONE built-in
   * section. A widget that prints ONE thing for all its instruments — a floor
   * plan's picture, a pie's slices, the alarm counts, the bars of every
   * instrument combined (`printsOneTable`) — is ONE section, printed with the
   * first profile's template (or the built-in), named for every profile it
   * covers: split by profile, every row would sit in the first and the rest
   * would read "No records." (ruling T1-C3, extended). Every other type: one
   * section per profile, in the server's order.
   */
  const sections: ChosenSection[] = useMemo(() => {
    const chosen = plan.sections.flatMap((s) => {
      // Refused, not printed (`unprofiled` below): never coerced to a blank profile.
      if (s.profileId === null || s.profileName === null) return [];
      const template = chooseTemplate(s, picks[planScopeKey(s)]);
      return [{
        profileId: s.profileId,
        profileName: s.profileName,
        instrumentIds: s.instrumentIds,
        availableIds: s.availableIds,
        template,
        document: template ? coerceReportTemplateDocument(template.document, type) : builtinReportTemplate(type),
      }];
    });
    if (printsOneTable(widget)) {
      // ONE section always (ruling T3-2): the first profile's template over the
      // selection's VISIBLE instruments (they scope the approval request); with
      // no instrument in view, the built-in — a text card's text and a floor
      // plan's picture still print (review I2, m2).
      const first = chosen[0];
      if (!first) return [{ profileId: '', profileName: '', instrumentIds: [], availableIds: [], template: null, document: builtinReportTemplate(type) }];
      return [{
        ...first,
        profileName: chosen.map((s) => s.profileName).join(', '),
        instrumentIds: chosen.flatMap((s) => s.instrumentIds),
      }];
    }
    return chosen;
  }, [plan.sections, picks, type, widget]);

  /**
   * A widget type is PROFILE-scoped: the server names a profile on every
   * section it resolves. A section without one is a broken answer — printing
   * the rest would drop its instruments from the record without a word, and a
   * blank profile would print a section named for nothing — so the dialog
   * shows the templates as failed and refuses the download.
   */
  const unprofiled = plan.sections.some((s) => s.profileId === null || s.profileName === null);

  const runDownload = async (req: ReportDownloadRequest) => {
    if (plan.error) throw new Error('The report templates could not be loaded. Close this and try again.');
    if (unprofiled) throw new Error(UNPROFILED_MESSAGE);
    if (plan.loading) throw new Error('The report templates are still loading. Try again in a moment.');
    const period = windowed ? { from: req.period.from, to: req.period.to } : null;
    if (period && !(Date.parse(period.from) < Date.parse(period.to))) {
      throw new Error('Choose a From that is before the To.');
    }

    const collected = await collectWidgetReport({
      widget,
      selection,
      ids: plan.ids,
      period,
      alarmFilters: view.alarmFilters ?? (widget.options.status ? { ...EMPTY_WIDGET_FILTERS, status: widget.options.status } : EMPTY_WIDGET_FILTERS),
      refs: reportRefs(sections.map((s) => s.document)),
      words,
      alarm,
      dates: { formatDate, formatTime, formatDateTime },
      floorplanSvg: view.floorplanSvg,
    });

    const perSection = sectionRows(collected.rows, sections);
    const fieldless = WIDGET_REPORT_FIELDS[type].length === 0;
    const built: WidgetReportSection[] = sections.map((s, n) => ({
      profileId: s.profileId,
      profileName: s.profileName,
      document: s.document,
      availableIds: s.availableIds,
      // A text card's text, a floor plan's nothing: exactly ONE section either way (ruling T3-2).
      rows: fieldless ? (type === 'text_card' ? collected.rows : []) : perSection[n],
      ...(n === 0 && collected.image ? { imageDataUrl: collected.image.dataUrl } : {}),
      values: { instrumentCount: String(s.instrumentIds.length) },
    }));

    const range = period ? `${formatDateTime(period.from)} – ${formatDateTime(period.to)}` : null;
    const instrumentIds = [...new Set(sections.flatMap((s) => s.instrumentIds))];
    const values: Partial<Record<Placeholder, string>> = {
      dashboard: dashboardTitle,
      widget: widget.title,
      // A present-state widget shows now; an alarm table follows no window but
      // its filters (review m8).
      period: range ?? (type === 'alarm_table' ? 'As filtered' : 'Latest'),
      from: period ? formatDateTime(period.from) : '—',
      to: period ? formatDateTime(period.to) : '—',
      date: formatDateTime(new Date().toISOString()),
      // The USERNAME, the identity the footer's "Printed By" and every
      // signature print — one person, one name on a record (review m5).
      user: user?.username ?? '',
      instrumentCount: String(instrumentIds.length),
      selection: widget.source.mode === 'instruments' ? 'Picked instruments' : selectionLabel,
    };

    const [{ buildWidgetReport }, { deliverReport, deliveryToast }] = await Promise.all([
      import('@/lib/widget-report'),
      import('@/lib/report-delivery'),
    ]);
    const result = await buildWidgetReport({ widgetType: type, values, sections: built, formatDateTime });
    // Every cap, every missing picture — said ON the record, never in a toast.
    for (const note of collected.notes) result.report.addNote(note, 'muted');

    const outcome = await deliverReport({
      kind: WIDGET_REPORT_KIND(type),
      req,
      report: result.report,
      reportType: widgetReportType(type),
      // The request schema caps them (500 / 1000): a long `{selection}` or
      // `{profile}` must not turn a Request into a bare 400 (review m11).
      title: clampText(result.title, REQUEST_TITLE_MAX),
      subtitle: result.subtitle === undefined ? undefined : clampText(result.subtitle, REQUEST_SUBTITLE_MAX),
      requestMeta: {
        recordCount: result.recordCount,
        search: widget.title,
        ...(period && range ? { period: { from: period.from, to: period.to, label: range } } : {}),
      },
      instrumentIds,
    });
    const notice = deliveryToast(outcome);
    toast[notice.tone](notice.title, notice.message);
    onClose();
  };

  return (
    <ReportDownloadDialog
      open
      reportName={widget.title}
      kind={WIDGET_REPORT_KIND(type)}
      initialPeriod={initialPeriod}
      showPeriod={windowed}
      extra={(
        <ReportTemplateLines
          kind={type}
          sections={plan.sections}
          picks={picks}
          onPick={(scopeKey, value) => setPicks((p) => ({ ...p, [scopeKey]: value }))}
          loading={plan.loading}
          oneSection={printsOneTable(widget)}
          failed={(plan.error !== undefined && plan.error !== null) || unprofiled}
          superAdmin={superAdmin}
        />
      )}
      onCancel={onClose}
      onConfirm={runDownload}
    />
  );
}
