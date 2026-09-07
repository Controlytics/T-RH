import { useState } from 'react';
import { TELEMETRY_DECIMALS_FALLBACK } from '@digilog/shared';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useExportOptions } from '@/hooks/use-export-options';
import { useSensorWords } from '@/hooks/use-failure-text';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { submitReportForReview } from '@/lib/report-review';
import { useToast } from '@/hooks/use-toast';
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
  const reauth = useReauth();
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
      await reauth.executeWithResult('DOWNLOAD_REPORT', async (password) => {
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
        // A REQUEST, not a file (2026-09-07): the frozen document goes to the
        // approver; the requester downloads it, signed, from the Reports page.
        const snapshot = report.getSnapshot();
        await submitReportForReview({
          snapshot, reportType: 'Instrument Time Series', title: snapshot.title,
          requestMeta: {
            period: reportPeriod, intervalMs: interval,
            recordCount: sections.reduce((n, s) => n + s.rows.length, 0),
            instrumentCodes: targets.map((t) => t.code),
          },
          remarks: req.remarks, assignee: req.assignee, password,
        });
      });
      setPendingDownload(false);
      toast.success('Sent for approval', `The request is with ${req.assigneeLabel || 'the approver'} — see Reports.`);
    } catch (e: any) {
      // A cancelled reauth prompt is not a failure. Any other error rethrows so
      // the dialog surfaces it and stays open.
      if (e?.error === 'REAUTH_CANCELLED') { setPendingDownload(false); return; }
      throw e;
    } finally {
      setProgress(null);
    }
  };

  if (!pdf) return null;

  return (
    <>
      <section
        data-testid="generate-report-card"
        className="mb-6 flex items-center justify-between gap-4 rounded-[var(--radius-card)] border border-slate-200 bg-white px-5 py-4 shadow-[var(--elev-1)]"
      >
        <p className="text-sm font-semibold text-slate-800">Generate Data report</p>
        <ExportMenu
          surface="instrument-history"
          iconOnly
          busy={pendingDownload}
          onExportPdf={() => setPendingDownload(true)}
        />
      </section>
      <ReportDownloadDialog
        open={pendingDownload}
        reportName="Data Report"
        showPeriod
        showInterval
        initialPeriod={{ from: period.from, to: period.to, label: period.label }}
        initialIntervalMs={period.intervalMs}
        progress={progress}
        onCancel={() => setPendingDownload(false)}
        onConfirm={runDownload}
      />
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Download Report"
      />
    </>
  );
}
