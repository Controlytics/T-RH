import { useEffect, useRef, useState } from 'react';
import {
  isPageTemplateKind, widgetReportType,
  type PageTemplateKind, type ReportField, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useAuth } from '@/hooks/use-auth';
import { FormSection } from '@/components/ui/form-section';
import type { TemplatedImage } from '@/lib/templated-report';
import { loadBuildTemplatedReport } from './load-builder';
import { sampleChartPng, samplePlaceholderValues, sampleRowsFor, type SampleFormatters, type SampleRow } from './sample-rows';

/** How long the draft must sit still before the PDF is drawn again. */
export const PREVIEW_DEBOUNCE_MS = 350;

/**
 * The `reportKey` each page report is drawn under today (the snapshot's
 * `reportType`; it chooses the footer's signatory label) — so the preview's
 * footer reads as the download's. A widget type's is `widgetReportType`.
 */
const PAGE_REPORT_KEYS: Record<PageTemplateKind, string> = {
  'page:data-report': 'instrument-trend',
  'page:trend': 'instrument-trend',
  'page:instrument-alarms': 'instrument-trend',
  'page:alarms': 'alarms',
  'page:audit-trail': 'audit-trail',
};

const reportKeyOf = (kind: TemplateKind): string => (isPageTemplateKind(kind) ? PAGE_REPORT_KEYS[kind] : widgetReportType(kind));

/**
 * The LIVE PREVIEW (spec §9; page kinds 2026-11-03): the real templated report
 * builder — the same `buildTemplatedReport` every download runs, widget or
 * page report — over sample rows built from the kind's catalogue and the kind's
 * sample placeholder values (`sample-rows.ts`), rendered into an `<iframe>`
 * from a blob URL and redrawn, debounced, after every edit. The Instrument
 * Trend prints a grey "Chart" picture where its chart goes.
 *
 * The catalogue ids are the section's `availableIds`, exactly as at download
 * time, so a column the profile no longer has shows here as it will print:
 * empty, and named under the table as not available. An application-wide kind
 * (`profileId` null) is one section with no profile.
 *
 * Nothing is drawn until the catalogue has arrived — before that, every key and
 * attribute column would be "not available", which is not what the template
 * will print. A late build never replaces a newer one (sequence number), and
 * each blob URL is revoked once it is replaced or the preview goes away.
 */
export function TemplatePreview({
  kind, profileId, profileName, document, fields,
}: {
  kind: TemplateKind;
  /** The profile, or null for an application-wide kind. */
  profileId: string | null;
  profileName: string | null;
  document: ReportTemplateDocument;
  /** The kind's catalogue (for the profile); undefined while it loads. */
  fields: readonly ReportField[] | undefined;
}) {
  const formatters = useDatetimeFormat();
  const { user } = useAuth();
  // {user} is the USERNAME — what a download prints and the footer's Printed By shows (review m5).
  const userName = user?.username || '';
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const seq = useRef(0);
  const current = useRef<string | null>(null);
  // The formatters are fresh functions every render; the latest ones are read
  // at build time instead of re-arming the debounce on every render.
  const fmt = useRef<SampleFormatters>(formatters);
  fmt.current = formatters;

  useEffect(() => () => {
    if (current.current) URL.revokeObjectURL(current.current);
  }, []);

  useEffect(() => {
    if (!fields) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const build = await loadBuildTemplatedReport();
          const at = (iso: string) => fmt.current.formatDateTime(iso);
          const values = samplePlaceholderValues(kind, fmt.current, userName, profileName);
          // A fieldless kind prints no table: the text card prints its text, the
          // trend its chart; every other kind prints three sample rows.
          const rows: SampleRow[] = kind === 'page:trend'
            ? []
            : fields.length === 0 && kind === 'text_card'
              ? [{ text: 'The text card’s own text prints here.' }]
              : sampleRowsFor(fields, at, fmt.current);
          const images: TemplatedImage[] | undefined = kind === 'page:trend' ? [{ dataUrl: sampleChartPng() }] : undefined;
          const { report } = await build({
            kind,
            reportKey: reportKeyOf(kind),
            values,
            sections: [{ profileId, profileName, document, rows, availableIds: fields.map((f) => f.id), ...(images ? { images } : {}) }],
            formatDateTime: at,
          });
          if (mine !== seq.current) return;
          const url = report.toBlobUrl();
          if (current.current) URL.revokeObjectURL(current.current);
          current.current = url;
          setSrc(url);
          setProblem(null);
        } catch (e) {
          if (mine !== seq.current) return;
          setProblem((e as { message?: string })?.message ?? 'The preview could not be drawn.');
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [kind, profileId, profileName, document, fields, userName]);

  const landscape = document.page.orientation === 'landscape';
  return (
    <FormSection
      title="Preview"
      columns={1}
      actions={src ? (
        <a href={src} target="_blank" rel="noopener noreferrer" className="text-xs font-semibold text-white underline-offset-2 hover:underline">
          Open full size
        </a>
      ) : undefined}
    >
      {problem && <p className="text-sm text-rose-700">{problem}</p>}
      <div
        data-testid="preview-frame"
        className={landscape ? 'aspect-[297/230] w-full' : 'aspect-[210/317] w-full'}
      >
        {src ? (
          <iframe
            title="Report preview"
            // FitH: the page fills the frame's width instead of opening at 100%.
            src={`${src}#view=FitH`}
            className="h-full w-full rounded-[var(--radius-control)] border border-slate-200 bg-slate-100"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center rounded-[var(--radius-control)] border border-dashed border-slate-300 bg-slate-50 text-sm text-slate-500">
            Preparing preview…
          </div>
        )}
      </div>
    </FormSection>
  );
}
