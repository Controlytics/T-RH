import {
  TEMPLATE_KIND_SPECS, WIDGET_TYPE_SPECS, isPageTemplateKind,
  type Placeholder, type ReportField, type TemplateKind,
} from '@digilog/shared';

/**
 * The rows the Report Templates PREVIEW prints (2026-11-02): three rows of
 * placeholder values, one value per catalogue field, typed by the field's
 * `kind`. They are not readings and never pretend to be — a text cell reads
 * "<label> 1", so a reviewer cannot mistake the preview for a real report.
 *
 * A datetime cell is a STRING, already formatted — `buildTemplatedReport` takes
 * rows "already formatted by the caller's datetime hook", and the preview's
 * caller passes the application's own formatter so the preview prints dates
 * the way the real download will. Given the date and time formatters too, a
 * page report's DATE column (`*.date`: `record.date`, `alarm.date`) prints the
 * date alone and its TIME column (`*.time`) the time alone, as the page does.
 */
export type SampleRow = Record<string, string | number | null>;

const NUMBERS = [21.5, 22.25, 23.75];
const STATUSES = ['Normal', 'Normal', 'High'];
/** Three instants a quarter of an hour apart, on a fixed day — not "now", so a preview is reproducible. */
const INSTANTS = ['2026-11-02T09:00:00.000Z', '2026-11-02T09:15:00.000Z', '2026-11-02T09:30:00.000Z'];

export function sampleRowsFor(
  fields: readonly ReportField[],
  formatDateTime: (iso: string) => string = (iso) => iso,
  parts?: Pick<SampleFormatters, 'formatDate' | 'formatTime'>,
): SampleRow[] {
  const instant = (id: string, iso: string): string => {
    if (parts && id.endsWith('.date')) return parts.formatDate(iso);
    if (parts && id.endsWith('.time')) return parts.formatTime(iso);
    return formatDateTime(iso);
  };
  return [0, 1, 2].map((i) => {
    const row: SampleRow = {};
    let n = 0;
    for (const f of fields) {
      switch (f.kind) {
        // Each number column its own figures (21.5, 31.5, 41.5 …), so two keys
        // side by side do not read as one value printed twice.
        case 'number': row[f.id] = NUMBERS[i]! + 10 * n++; break;
        case 'datetime': row[f.id] = instant(f.id, INSTANTS[i]!); break;
        case 'status': row[f.id] = STATUSES[i]!; break;
        default: row[f.id] = `${f.label} ${i + 1}`;
      }
    }
    return row;
  });
}

/** The application's datetime formatters (`useDatetimeFormat()`) — the pages print a period's date and time apart. */
export interface SampleFormatters {
  formatDate: (value: string) => string;
  formatTime: (value: string) => string;
  formatDateTime: (value: string) => string;
}

/** The sample window: the 24 hours to a fixed instant, so a preview is reproducible. */
const FROM = '2026-11-01T09:30:00.000Z';
const TO = '2026-11-02T09:30:00.000Z';

/**
 * The placeholder values the PREVIEW prints, per template kind (2026-11-03,
 * page reports on templates): the values a real download of that kind
 * supplies, as samples. A widget type gets the ten its preview always printed
 * (a present-time widget has no window: its period reads "Latest" and
 * {from} / {to} print —). A page kind gets a sample instrument and its
 * placement, the period (and its date and time apart), the Data Report's
 * limits / interval / MKT / extremes, the trend's series, the Alarm Report's
 * record count / search / level.
 *
 * Only the KIND's own placeholders are returned (`TEMPLATE_KIND_SPECS[kind]
 * .placeholders`): a name the kind does not supply prints — in the real
 * download, so it prints — in the preview too, never a sample that would make
 * the template look as if it worked. `profileName` is null for an
 * application-wide kind, which has no profile.
 */
export function samplePlaceholderValues(
  kind: TemplateKind,
  fmt: SampleFormatters,
  userName: string,
  profileName: string | null,
): Partial<Record<Placeholder, string>> {
  const windowed = isPageTemplateKind(kind) || WIDGET_TYPE_SPECS[kind].followsWindow;
  const all: Partial<Record<Placeholder, string>> = {
    // A widget's own.
    dashboard: 'Sample dashboard',
    ...(isPageTemplateKind(kind) ? {} : { widget: WIDGET_TYPE_SPECS[kind].label }),
    instrumentCount: '3',
    ...(profileName !== null ? { profile: profileName, selection: profileName } : {}),
    // The period.
    period: windowed ? 'Last 24 hours' : 'Latest',
    ...(windowed ? {
      from: fmt.formatDateTime(FROM),
      to: fmt.formatDateTime(TO),
      fromDate: fmt.formatDate(FROM),
      fromTime: fmt.formatTime(FROM),
      toDate: fmt.formatDate(TO),
      toTime: fmt.formatTime(TO),
    } : {}),
    // The reader and the moment.
    date: fmt.formatDateTime(new Date().toISOString()),
    user: userName,
    // One instrument and where it is.
    instrument: 'CWH/RDU/001-00',
    block: 'CWH',
    area: 'QC',
    location: 'Lab 1',
    // The Data Report's parameters.
    tempLimit: '18.0 - 27.0',
    rhLimit: '40 - 60',
    interval: '15 min',
    mkt: '22.1',
    extremes: 'Max 24.1 · Min 20.3',
    // The trend's slot; the Alarm Report's and the Audit Trail's figures.
    series: 'Temperature',
    recordCount: '3',
    search: '—',
    level: 'All',
  };
  const supplied = new Set<string>(TEMPLATE_KIND_SPECS[kind].placeholders);
  return Object.fromEntries(Object.entries(all).filter(([name]) => supplied.has(name))) as Partial<Record<Placeholder, string>>;
}

/**
 * The attribute values the PREVIEW hands a page report's section
 * (`TemplatedSection.attributes`): a page download hands its ONE instrument's
 * attributes to the `attr:` information rows, so the preview hands a sample
 * per catalogue attribute — "<label> 1", the sample rows' wording — and an
 * attribute row previews as it will print. A widget section reads attributes
 * from its rows, as its download does, so a widget type gets none; nor does a
 * kind that takes no profile fields, or a catalogue with no attributes.
 */
export function sampleAttributeValues(kind: TemplateKind, fields: readonly ReportField[]): Record<string, string> | undefined {
  if (!isPageTemplateKind(kind) || TEMPLATE_KIND_SPECS[kind].profileFields === 'none') return undefined;
  const attributes = fields.filter((f) => f.group === 'attribute');
  return attributes.length > 0 ? Object.fromEntries(attributes.map((f) => [f.id, `${f.label} 1`])) : undefined;
}

/** The sample chart's size in pixels — the proportions of the trend page's chart picture. */
export const SAMPLE_CHART_WIDTH = 1200;
export const SAMPLE_CHART_HEIGHT = 500;

let sampleChart: string | null = null;

/**
 * The picture the `page:trend` preview prints where the real report prints the
 * chart: a 1200 x 500 grey PNG with the word "Chart" on it — sized as the real
 * chart, and plainly not one. Drawn once and remembered. A browser with no 2D
 * canvas cannot draw it: that THROWS, and the preview says the preview could
 * not be drawn rather than print a report with its picture missing.
 */
export function sampleChartPng(): string {
  if (sampleChart) return sampleChart;
  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_CHART_WIDTH;
  canvas.height = SAMPLE_CHART_HEIGHT;
  const g = canvas.getContext('2d');
  if (!g) throw new Error('The sample chart could not be drawn: this browser has no canvas.');
  g.fillStyle = '#e2e8f0';
  g.fillRect(0, 0, SAMPLE_CHART_WIDTH, SAMPLE_CHART_HEIGHT);
  g.strokeStyle = '#94a3b8';
  g.lineWidth = 4;
  g.strokeRect(2, 2, SAMPLE_CHART_WIDTH - 4, SAMPLE_CHART_HEIGHT - 4);
  g.fillStyle = '#64748b';
  g.font = '600 96px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('Chart', SAMPLE_CHART_WIDTH / 2, SAMPLE_CHART_HEIGHT / 2);
  const url = canvas.toDataURL('image/png');
  if (!url || !url.startsWith('data:image/png')) throw new Error('The sample chart could not be drawn.');
  sampleChart = url;
  return url;
}
