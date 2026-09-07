import { useState } from 'react';
import { ExportMenu } from '@/components/ExportMenu';
import { ReportDownloadDialog, type ReportDownloadRequest } from '@/components/report-download-dialog';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useReauth } from '@/hooks/use-reauth';
import { useSensorWords } from '@/hooks/use-failure-text';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { logReportExport } from '@/lib/report-export-log';
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
 * for surface `instrument-history` still applies — a role allowed no PDF here
 * sees the text and no icon.
 */
export function GenerateReportCard({ scope }: { scope: HistoryScope }) {
  const { period } = useTrendPeriod();
  const [pendingDownload, setPendingDownload] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const reauth = useReauth();
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
        const sections: DataReportInput[] = [];
        for (const [i, inst] of targets.entries()) {
          setProgress(`Reading ${inst.code} (${i + 1} of ${targets.length})…`);
          const ov = scope.overviewById.get(inst.id);
          const tempKey = ov?.temperature?.key ?? null;
          const humidKey = ov?.humidity?.key ?? null;
          const slotKeys = [tempKey, humidKey].filter((k): k is string => k !== null);
          const fetched = await fetchDataReportRows({
            instrumentId: inst.id, from: reportPeriod.from, to: reportPeriod.to, intervalMs: interval, slotKeys,
          });
          sections.push({
            scope: {
              ...resolveBlockArea(scope.tree, inst.functionalLocationId ?? null),
              locationName: ov?.locationAttribute ?? '',
              instrumentLabel: inst.code,
            },
            period: reportPeriod, fmt, formatDateTime,
            temp: {
              key: tempKey, min: ov?.limits?.tempMin, max: ov?.limits?.tempMax,
              decimals: ov?.decimals.temperature ?? 1,
              rangeLow: ov?.rangeBounds?.temperatureLow ?? null, rangeHigh: ov?.rangeBounds?.temperatureHigh ?? null,
              ...slotExtremes(fetched.summaries, tempKey),
            },
            rh: {
              key: humidKey, min: ov?.limits?.rhMin, max: ov?.limits?.rhMax,
              decimals: ov?.decimals.humidity ?? 0,
              rangeLow: ov?.rangeBounds?.humidityLow ?? null, rangeHigh: ov?.rangeBounds?.humidityHigh ?? null,
              ...slotExtremes(fetched.summaries, humidKey),
            },
            rows: fetched.rows, intervalMs: interval, coverage: fetched.coverage, words: sensorWords,
          });
        }
        setProgress('Building the report…');
        const report = await renderDataReports({ formatDateTime, instruments: sections });
        // Fail-closed: the audit write happens BEFORE the file is saved.
        await logReportExport({
          reportType: 'Instrument Time Series', format: 'PDF',
          recordCount: sections.reduce((n, s) => n + s.rows.length, 0),
          period: reportPeriod.label, startDate: reportPeriod.from, endDate: reportPeriod.to,
          search: `${targets.length} instrument${targets.length === 1 ? '' : 's'}: ${targets.map((t) => t.code).join(', ')}`,
          remarks: req.remarks, password,
        });
        const stamp = new Date().toISOString().slice(0, 10);
        report.save(`data-report-${stamp}.pdf`);
      });
      setPendingDownload(false);
    } catch (e: any) {
      // A cancelled reauth prompt is not a failure. Any other error rethrows so
      // the dialog surfaces it and stays open.
      if (e?.error === 'REAUTH_CANCELLED') { setPendingDownload(false); return; }
      throw e;
    } finally {
      setProgress(null);
    }
  };

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
