import { useState } from 'react';
import { TELEMETRY_DECIMALS_FALLBACK } from '@digilog/shared';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { useExportOptions } from '@/hooks/use-export-options';
import { useSensorWords } from '@/hooks/use-failure-text';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { deliverReport, deliveryToast } from '@/lib/report-delivery';
import { useToast } from '@/hooks/use-toast';
import { themeGradient } from '@/lib/theme-styles';
import { useTrendPeriod } from '@/routes/instruments/use-trend-data';
import { fetchDataReportRows, slotExtremes } from '@/routes/instruments/data-report-fetch';
import { renderDataReports, type DataReportInput } from '@/routes/instruments/trend-report';
import { resolveBlockArea } from '@/routes/instruments/data-report';
import type { HistoryScope } from './use-history-scope';

/**
 * Generate Data Report (2026-09-07). Operator: *"create one card only text
 * should be there Generate Data report and one download icon, when ever user
 * click on that download icon i need same dialog with time period selection,
 * interval and remarks then password reauthentication same like how
 * timeseries widget is behaving … and report should be same report of time
 * series widget"*.
 *
 * The page's ONE download trigger. It reports the page's current selection
 * (`useHistoryScope`, shared with the widget below it): the same governed
 * dialog, the same `DOWNLOAD_REPORT` re-auth and the same audit row as the
 * trend page's Time Series card, and the same document — one Data Report page
 * per selected instrument, each built by the trend page's own fetch helper and
 * section renderer, with NO cover block in front (the operator's choice when
 * asked; the cover the 2026-09-05 widget printed is gone with it). The audit
 * `reportType` is therefore the Time Series one, `Instrument Time Series`: it
 * IS that report, for each instrument. The `search` column names which.
 *
 * The icon is `ExportMenu` (icon-only) so the per-role Export Options gating
 * for surface `instrument-history` still applies — and a role allowed no PDF
 * here gets NO CARD, not the text beside a missing icon: "Generate Data
 * report" with nothing to press is an inert control, the decoy this codebase
 * keeps a rule against (audit, 2026-09-07).
 */
/** Instruments read at once. Two requests each; four keeps an Area of thirty
 *  to a few seconds without hammering the API. */
const READ_CONCURRENCY = 4;

/** `Promise.all` with at most `limit` tasks in flight; results by index. */
async function mapWithConcurrency<T>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

export function GenerateReportCard({ scope }: { scope: HistoryScope }) {
  const { pdf } = useExportOptions('instrument-history');
  const { period } = useTrendPeriod();
  const [pendingDownload, setPendingDownload] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const { toast } = useToast();
  const sensorWords = useSensorWords();
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();

  const runDownload = async (req: ReportDownloadRequest) => {
    const targets = scope.chosen;
    if (targets.length === 0) throw new Error('Select at least one instrument to report on.');
    const reportPeriod = { from: req.period.from, to: req.period.to, label: req.period.label };
    const interval = req.intervalMs !== undefined ? req.intervalMs : period.intervalMs;
    const fmt = { formatDate, formatTime };
    try {
      {
        // Every instrument is read (two requests each) with a few in flight at
        // once — an Area of thirty read one after another was 60 serial round
        // trips (review, 2026-09-07). Sections land by INDEX, so the document
        // keeps the selection's order whatever order the reads complete in.
        const sections: DataReportInput[] = new Array(targets.length);
        let done = 0;
        const readOne = async (inst: (typeof targets)[number], i: number) => {
          const ov = scope.overviewById.get(inst.id);
          const tempKey = ov?.temperature?.key ?? null;
          const humidKey = ov?.humidity?.key ?? null;
          const slotKeys = [tempKey, humidKey].filter((k): k is string => k !== null);
          const fetched = await fetchDataReportRows({
            instrumentId: inst.id, from: reportPeriod.from, to: reportPeriod.to, intervalMs: interval, slotKeys,
          });
          sections[i] = {
            scope: {
              ...resolveBlockArea(scope.tree, inst.functionalLocationId ?? null),
              locationName: ov?.locationAttribute ?? '',
              instrumentLabel: inst.code,
            },
            period: reportPeriod, fmt, formatDateTime,
            temp: {
              key: tempKey, min: ov?.limits?.tempMin, max: ov?.limits?.tempMax,
              // The ONE fallback, shared with the trend page: two documents under
              // one audit type must not print one instrument at two precisions.
              decimals: ov?.decimals.temperature ?? TELEMETRY_DECIMALS_FALLBACK,
              rangeLow: ov?.rangeBounds?.temperatureLow ?? null, rangeHigh: ov?.rangeBounds?.temperatureHigh ?? null,
              ...slotExtremes(fetched.summaries, tempKey),
            },
            rh: {
              key: humidKey, min: ov?.limits?.rhMin, max: ov?.limits?.rhMax,
              decimals: ov?.decimals.humidity ?? TELEMETRY_DECIMALS_FALLBACK,
              rangeLow: ov?.rangeBounds?.humidityLow ?? null, rangeHigh: ov?.rangeBounds?.humidityHigh ?? null,
              ...slotExtremes(fetched.summaries, humidKey),
            },
            rows: fetched.rows, intervalMs: interval, coverage: fetched.coverage, words: sensorWords,
          };
          done += 1;
          setProgress(`Read ${done} of ${targets.length} instruments…`);
        };
        await mapWithConcurrency(targets, READ_CONCURRENCY, readOne);
        setProgress('Building the report…');
        const report = await renderDataReports({ formatDateTime, instruments: sections });
        // Direct or Request, as Configuration → Report Downloads says for the
        // Data Report (2026-10-01). The instrument IDS go with a request — they
        // decide who may see it; the codes are only what the list prints.
        const outcome = await deliverReport({
          kind: 'data-report', req, report, reportType: 'Instrument Time Series', title: report.getSnapshot().title,
          requestMeta: {
            period: reportPeriod, intervalMs: interval,
            recordCount: sections.reduce((n, s) => n + s.rows.length, 0),
            instrumentCodes: targets.map((t) => t.code),
          },
          instrumentIds: targets.map((t) => t.id),
        });
        setPendingDownload(false);
        toast.success(...deliveryToast(outcome));
      }
    } catch (e: any) {
      // Any error rethrows so the dialog surfaces it and stays open.
      throw e;
    } finally {
      setProgress(null);
    }
  };

  if (!pdf) return null;

  // What a press of the icon would report — the same selection the widget
  // below shows, in one line, so the operator never has to scroll down to
  // check before requesting.
  const where = scope.areaId
    ? scope.areas.find((a) => a.id === scope.areaId)?.name
    : scope.tree.find((b) => b.id === scope.blockId)?.name;
  const summary = scope.chosen.length === 0
    ? 'Choose a Block or Area, or tick instruments below'
    : `${scope.chosen.length} instrument${scope.chosen.length === 1 ? '' : 's'} · ${period.label}${where ? ` · ${where}` : ''}`;

  return (
    <>
      {/* The page's one bold element (restyled 2026-09-16, operator: "make it
          more professional … more colorful"): the site-theme band the
          Settings widget uses, the action named large, the selection it will
          report beneath it, and the ONE download icon on a white plate so it
          reads on any of the ten themes. Still one button, still `ExportMenu`
          (Export Options gating), still `null` for a role allowed no PDF. */}
      <section
        data-testid="generate-report-card"
        className="relative mb-6 flex items-center justify-between gap-4 overflow-hidden rounded-[var(--radius-card)] px-6 py-5 text-white shadow-[var(--elev-2)]"
        style={themeGradient}
      >
        <div aria-hidden className="pointer-events-none absolute -right-10 -top-16 h-48 w-48 rounded-full bg-white/10" />
        <div aria-hidden className="pointer-events-none absolute -bottom-20 left-1/3 h-40 w-40 rounded-full bg-white/5" />
        <div className="relative min-w-0">
          <p className="font-display text-2xl font-bold leading-none tracking-tight">Generate Data report</p>
          <p className="mt-2 truncate text-[0.8125rem] text-white/80" data-testid="generate-report-summary">{summary}</p>
        </div>
        <div className="relative shrink-0 rounded-xl bg-white p-1 shadow-[var(--elev-1)]">
          <ExportMenu
            surface="instrument-history"
            iconOnly
            busy={pendingDownload}
            onExportPdf={() => setPendingDownload(true)}
          />
        </div>
      </section>
      <ReportDownloadDialog
        open={pendingDownload}
        reportName="Data Report"
        kind="data-report"
        showPeriod
        showInterval
        initialPeriod={{ from: period.from, to: period.to, label: period.label }}
        initialIntervalMs={period.intervalMs}
        progress={progress}
        onCancel={() => setPendingDownload(false)}
        onConfirm={runDownload}
      />
    </>
  );
}
