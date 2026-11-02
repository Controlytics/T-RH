import { useEffect, useRef, useState } from 'react';
import {
  WIDGET_TYPE_SPECS, type Placeholder, type ReportField, type ReportTemplateDocument, type WidgetType,
} from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useAuth } from '@/hooks/use-auth';
import { FormSection } from '@/components/ui/form-section';
import { loadBuildWidgetReport } from './load-builder';
import { sampleRowsFor, type SampleRow } from './sample-rows';

/** How long the draft must sit still before the PDF is drawn again. */
export const PREVIEW_DEBOUNCE_MS = 350;

/**
 * The LIVE PREVIEW (spec §9): the real widget report builder — the same
 * `buildWidgetReport` a widget's Download report runs — over three sample rows
 * built from the profile's catalogue, rendered into an `<iframe>` from a blob
 * URL and redrawn, debounced, after every edit.
 *
 * The catalogue ids are the section's `availableIds`, exactly as at download
 * time, so a column the profile no longer has shows here as it will print:
 * empty, and named under the table as not available.
 *
 * Nothing is drawn until the catalogue has arrived — before that, every key and
 * attribute column would be "not available", which is not what the template
 * will print. A late build never replaces a newer one (sequence number), and
 * each blob URL is revoked once it is replaced or the preview goes away.
 */
export function TemplatePreview({
  widgetType, profileId, profileName, document, fields,
}: {
  widgetType: WidgetType;
  profileId: string;
  profileName: string;
  document: ReportTemplateDocument;
  /** The profile's catalogue for this widget type; undefined while it loads. */
  fields: readonly ReportField[] | undefined;
}) {
  const { formatDateTime } = useDatetimeFormat();
  const { user } = useAuth();
  const userName = user?.fullName || user?.username || '';
  const [src, setSrc] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const seq = useRef(0);
  const current = useRef<string | null>(null);
  // The formatter is a fresh function every render; the latest one is read at
  // build time instead of re-arming the debounce on every render.
  const fmt = useRef(formatDateTime);
  fmt.current = formatDateTime;

  useEffect(() => () => {
    if (current.current) URL.revokeObjectURL(current.current);
  }, []);

  useEffect(() => {
    if (!fields) return;
    const mine = ++seq.current;
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const build = await loadBuildWidgetReport();
          const spec = WIDGET_TYPE_SPECS[widgetType];
          const at = (iso: string) => fmt.current(iso);
          // The values a download supplies, as samples. A present-time widget
          // has no window: its period reads "Latest" and {from} / {to} print —.
          const values: Partial<Record<Placeholder, string>> = {
            dashboard: 'Sample dashboard',
            widget: spec.label,
            profile: profileName,
            period: spec.followsWindow ? 'Last 24 hours' : 'Latest',
            ...(spec.followsWindow ? { from: at('2026-11-01T09:30:00.000Z'), to: at('2026-11-02T09:30:00.000Z') } : {}),
            date: at(new Date().toISOString()),
            user: userName,
            instrumentCount: '3',
            selection: profileName,
          };
          const rows: SampleRow[] = fields.length === 0 && widgetType === 'text_card'
            ? [{ text: 'The text card’s own text prints here.' }]
            : sampleRowsFor(fields, at);
          const { report } = await build({
            widgetType,
            values,
            sections: [{ profileId, profileName, document, rows, availableIds: fields.map((f) => f.id) }],
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
  }, [widgetType, profileId, profileName, document, fields, userName]);

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
