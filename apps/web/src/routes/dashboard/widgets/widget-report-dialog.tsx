/**
 * A dashboard widget's "Download report" (2026-11-02) — spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §7-§8.
 *
 * The governed `ReportDownloadDialog`, kind `widget:<type>` (Direct or Request
 * per Configuration → Report Settings), with what the report will be printed
 * with above its fields: per instrument profile, the template the SERVER
 * resolved ("Template: <name> (<profile>)", or "Built-in"), a picker when the
 * profile has more than one, and — for a SUPER_ADMIN — the way to the editor.
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
import { Link } from 'react-router-dom';
import {
  DEFAULT_PERIOD, PERIOD_PRESETS, WIDGET_REPORT_FIELDS, WIDGET_REPORT_KIND, WIDGET_TYPE_SPECS,
  builtinReportTemplate, coerceReportTemplateDocument, widgetReportType,
  type CustomWidget, type Placeholder, type ReportTemplateDocument,
} from '@digilog/shared';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
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
import {
  collectWidgetReport, reportRefs, sectionRows, useWidgetReportPlan, type PlanSection, type ReportTemplateRow,
} from './widget-report-data';

/** The picker's value for "print with the built-in template". */
const BUILTIN = '__builtin__';

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
 * Whether the widget's report is ONE table (or picture) for all its
 * instruments — no row of it names a single instrument, so it cannot be split
 * by profile: the floor plan, the pie, the alarm counts, the bars of every
 * instrument combined.
 */
export function printsOneTable(widget: CustomWidget): boolean {
  return widget.type === 'floorplan' || widget.type === 'pie_chart' || widget.type === 'alarm_counts'
    || (widget.type === 'bar_chart' && (widget.options.groupBy ?? BAR_DEFAULTS.groupBy) === 'all');
}

function chooseTemplate(s: PlanSection, pick: string | undefined): ReportTemplateRow | null {
  if (pick === BUILTIN) return null;
  return s.templates.find((t) => t.id === pick) ?? s.resolved;
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
    const chosen = plan.sections.map((s) => {
      const template = chooseTemplate(s, picks[s.profileId]);
      return {
        profileId: s.profileId,
        profileName: s.profileName,
        instrumentIds: s.instrumentIds,
        availableIds: s.availableIds,
        template,
        document: template ? coerceReportTemplateDocument(template.document, type) : builtinReportTemplate(type),
      };
    });
    if (type === 'text_card') {
      // The built-in, over the selection's VISIBLE instruments (fix wave 1):
      // they scope the approval request; [] only when the selection has none.
      return [{
        profileId: '', profileName: '', instrumentIds: chosen.flatMap((s) => s.instrumentIds),
        availableIds: [], template: null, document: builtinReportTemplate(type),
      }];
    }
    if (printsOneTable(widget) && chosen.length > 0) {
      const first = chosen[0];
      return [{
        ...first,
        profileName: chosen.map((s) => s.profileName).join(', '),
        instrumentIds: chosen.flatMap((s) => s.instrumentIds),
      }];
    }
    return chosen;
  }, [plan.sections, picks, type, widget]);

  const runDownload = async (req: ReportDownloadRequest) => {
    if (plan.error) throw new Error('The report templates could not be loaded. Close this and try again.');
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
      period: range ?? 'Latest',
      from: period ? formatDateTime(period.from) : '—',
      to: period ? formatDateTime(period.to) : '—',
      date: formatDateTime(new Date().toISOString()),
      user: user?.fullName || user?.username || '',
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
      title: result.title,
      subtitle: result.subtitle,
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
        <WidgetReportTemplates
          type={type}
          sections={sections}
          plan={plan.sections}
          picks={picks}
          onPick={(profileId, value) => setPicks((p) => ({ ...p, [profileId]: value }))}
          loading={plan.loading}
          failed={plan.error !== undefined && plan.error !== null}
          superAdmin={superAdmin}
        />
      )}
      onCancel={onClose}
      onConfirm={runDownload}
    />
  );
}

/**
 * What the report will be printed with, per profile: the server's resolution
 * (or the one picked), a picker when the profile has more than one template,
 * and for a SUPER_ADMIN the way to the editor.
 */
export function WidgetReportTemplates({ type, sections, plan, picks, onPick, loading, failed, superAdmin }: {
  type: CustomWidget['type'];
  sections: readonly ChosenSection[];
  plan: readonly PlanSection[];
  picks: Readonly<Record<string, string>>;
  onPick: (profileId: string, value: string) => void;
  loading: boolean;
  failed: boolean;
  superAdmin: boolean;
}) {
  if (failed) {
    return <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">The report templates could not be loaded.</p>;
  }
  if (loading) return <p className="text-sm text-slate-500">Loading the report templates…</p>;
  if (type !== 'text_card' && plan.length === 0) {
    return <p className="text-sm text-slate-600" data-testid="widget-report-template">No instruments in this selection — the report says so.</p>;
  }
  return (
    <ul className="space-y-2" aria-label="Report templates">
      {sections.map((s) => {
        const p = plan.find((x) => x.profileId === s.profileId);
        const name = s.template ? s.template.name : 'Built-in';
        const profile = s.profileName || p?.profileName || '';
        return (
          <li key={s.profileId || 'builtin'} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-sm font-medium text-slate-800" data-testid="widget-report-template">
              {profile ? `Template: ${name} (${profile})` : `Template: ${name}`}
            </p>
            {p && p.templates.length > 1 && (
              <select
                aria-label={`Template for ${p.profileName}`}
                className="ctl ctl-sm mt-1.5 w-full"
                value={picks[p.profileId] ?? p.resolved?.id ?? BUILTIN}
                onChange={(e) => onPick(p.profileId, e.target.value)}
              >
                {p.templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.isDefault ? `${t.name} (default)` : t.name}</option>
                ))}
                <option value={BUILTIN}>Built-in</option>
              </select>
            )}
            {superAdmin && p && (
              <Link
                to={`/config/report-templates?${new URLSearchParams({ profileId: p.profileId, widgetType: type }).toString()}`}
                className="mt-1 inline-block text-xs font-semibold text-[var(--theme-primary)] hover:underline"
              >
                Edit report templates for {p.profileName}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
