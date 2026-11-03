/**
 * REPORT TEMPLATES — what a dashboard widget's "Download report" prints, per
 * instrument PROFILE, per WIDGET TYPE (2026-11-02).
 *
 * Spec: docs/superpowers/specs/2026-11-02-widget-report-templates-design.md
 * (§4 vocabulary, §6 field catalogue, §7 which template, §8 the download).
 *
 * A template is a row of `report_templates` (profile × widget type × name, one
 * default) holding a versioned JSON DOCUMENT. This file is the shared contract
 * of that document and of what surrounds it:
 *
 *  - `reportTemplateDocumentSchema` — the ONE strict validator (every write);
 *  - `coerceReportTemplateDocument` — the ONE forgiving reader (every read: a
 *    stored document that fails the schema reads as the type's built-in, it
 *    never throws and never half-applies);
 *  - `WIDGET_REPORT_FIELDS` — each widget type's BUILT-IN fields. The server's
 *    catalogue (`GET /api/report-templates/catalogue`) serves them together with
 *    the profile's `key:<name>` and `attr:<name>` fields; the browser never
 *    re-derives the catalogue;
 *  - `builtinReportTemplate` — the shipped document per type, used when a
 *    profile has no template and as the start of "+ New template";
 *  - `substitutePlaceholders` — `{dashboard}`, `{to}` … in titles; text only
 *    (jsPDF draws text, nothing is ever interpreted as markup);
 *  - `WIDGET_REPORT_KIND` / `widgetReportType` — the download policy kind
 *    (`REPORT_KINDS` in report-downloads.ts) and the audit reportType.
 *
 * PAGE REPORTS ON TEMPLATES (2026-11-03, spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §4, §6):
 * a template is for a TEMPLATE KIND — a widget type, or one of the five page
 * reports (`PAGE_TEMPLATE_KINDS`). `TEMPLATE_KIND_SPECS` is the ONE description
 * of each kind (scope, profile fields, built-in fields, placeholders,
 * orientation, typography); its widget half is BUILT from the widget records
 * above it, never typed twice. `templateKindOf` maps a download kind onto the
 * template it is drawn from.
 *
 * This file must not import report-downloads.ts at RUNTIME: that one imports
 * this. It imports its TYPES only (`import type`, erased on build).
 */
import { z } from 'zod';
import { WIDGET_TYPES, WIDGET_TYPE_SPECS, type WidgetType } from './dashboard-widgets.js';
import type { ReportKind } from './report-downloads.js';

export const REPORT_TEMPLATE_DOCUMENT_VERSION = 1;

/** A template's name, on the row (the document has none). */
export const REPORT_TEMPLATE_NAME_MAX = 80;
/** A custom logo, as the whole `data:` URL, in characters (~730 KB of image). */
export const REPORT_TEMPLATE_LOGO_MAX = 1_000_000;
/**
 * How large an IMAGE fits under that cap, in KB (1,024 bytes) rounded DOWN to
 * ten: base64 is four characters per three bytes, after the 23-character
 * `data:image/jpeg;base64,` prefix. 730 for 1,000,000 characters. DERIVED from
 * the cap, so the sentence an admin reads can never disagree with the check
 * (fix wave 1, 2026-11-02: it said "1 MB", and an 800 KB PNG was "over 1 MB").
 */
export const REPORT_TEMPLATE_LOGO_IMAGE_KB =
  Math.floor(((REPORT_TEMPLATE_LOGO_MAX - 'data:image/jpeg;base64,'.length) * 3) / 4 / 1024 / 10) * 10;
const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
/** The refusal of a logo over the cap — the schema's words, worded from the two numbers above. */
export const REPORT_TEMPLATE_LOGO_TOO_LARGE =
  `The logo must be about ${REPORT_TEMPLATE_LOGO_IMAGE_KB} KB of image or smaller (${thousands(REPORT_TEMPLATE_LOGO_MAX)} characters as a data URL)`;
export const REPORT_TEMPLATE_COLUMNS_MAX = 100;
export const REPORT_TEMPLATE_INFO_ROWS_MAX = 20;
export const REPORT_TEMPLATE_HEADING_MAX = 80;
export const REPORT_TEMPLATE_TITLE_MAX = 200;
export const REPORT_TEMPLATE_TEXT_MAX = 300;
export const REPORT_TEMPLATE_LEGEND_MAX = 1000;
/** A catalogue id: `key:` / `attr:` plus a key (`DATA_KEY_MAX` is 128). */
export const REPORT_FIELD_ID_MAX = 140;

/** What an absent value prints as — in a title, an info row or a cell. */
export const REPORT_VALUE_MISSING = '—';

// ── Template kinds ──────────────────────────────────────────────────────────

/**
 * The page reports a template can drive (2026-11-03): the five built-in PDF
 * layouts the pages draw — Data Report, Instrument Trend, Instrument Alarms,
 * Alarm Report, Audit Trail. Stored in `report_templates.kind` beside the
 * widget types: validated strings, no enum. APPENDED to, never renamed —
 * stored rows name them.
 */
export const PAGE_TEMPLATE_KINDS = [
  'page:data-report', 'page:trend', 'page:instrument-alarms', 'page:alarms', 'page:audit-trail',
] as const;
export type PageTemplateKind = (typeof PAGE_TEMPLATE_KINDS)[number];

/** What a template is FOR: a widget type's Download report, or a page report. */
export type TemplateKind = WidgetType | PageTemplateKind;

/**
 * Every template kind — the widget types, then the page kinds. A TUPLE (not a
 * plain array), because `z.enum` takes one.
 */
export const TEMPLATE_KINDS = [...WIDGET_TYPES, ...PAGE_TEMPLATE_KINDS] as const;

export function isTemplateKind(v: unknown): v is TemplateKind {
  return typeof v === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(v);
}

export function isPageTemplateKind(v: unknown): v is PageTemplateKind {
  return typeof v === 'string' && (PAGE_TEMPLATE_KINDS as readonly string[]).includes(v);
}

/** The page download kinds — `REPORT_KINDS` without the `widget:<type>` ones. */
type PageDownloadKind = Exclude<ReportKind, WidgetReportKind>;

/**
 * Which template each page download is drawn from (spec §4). Three download
 * points print the ONE Data Report; the two trend charts print the ONE trend
 * layout. Typed over every page download kind, so a new download kind does not
 * compile until it is mapped here.
 */
const PAGE_DOWNLOAD_TEMPLATE_KIND: Readonly<Record<PageDownloadKind, PageTemplateKind>> = {
  'data-report': 'page:data-report',
  'time-series': 'page:data-report',
  'trend-header': 'page:data-report',
  'temperature-trend': 'page:trend',
  'humidity-trend': 'page:trend',
  'instrument-alarms': 'page:instrument-alarms',
  alarms: 'page:alarms',
  'audit-trail': 'page:audit-trail',
};

const WIDGET_KIND_PREFIX = 'widget:';

/**
 * The template kind a download kind is drawn from: a page download → its page
 * kind, `widget:<type>` → `<type>`. The download kinds themselves (Report
 * Settings, approvers, the audit `reportType`) are unchanged — only the
 * template lookup maps them. A string that is no download kind THROWS: it is a
 * caller's bug, and an `undefined` typed as a kind would travel on silently.
 */
export function templateKindOf(downloadKind: ReportKind): TemplateKind {
  if (typeof downloadKind === 'string' && downloadKind.startsWith(WIDGET_KIND_PREFIX)) {
    const t = downloadKind.slice(WIDGET_KIND_PREFIX.length);
    if ((WIDGET_TYPES as readonly string[]).includes(t)) return t as WidgetType;
  } else if (Object.prototype.hasOwnProperty.call(PAGE_DOWNLOAD_TEMPLATE_KIND, downloadKind)) {
    return PAGE_DOWNLOAD_TEMPLATE_KIND[downloadKind as PageDownloadKind];
  }
  throw new Error(`"${String(downloadKind)}" is not a report kind`);
}

// ── Fields ──────────────────────────────────────────────────────────────────

export type ReportFieldGroup = 'builtin' | 'key' | 'attribute';
export type ReportFieldKind = 'text' | 'number' | 'datetime' | 'status';

/**
 * One field a template may print. `id` is the column's id in a document:
 * a built-in `<namespace>.<name>` (this file), `key:<telemetry key>` or
 * `attr:<attribute key>` (the server's catalogue). `unit` and `measured` are
 * the catalogue's for a key field (a measured key's unit is the measurement's).
 *
 * `perKey` marks a built-in field whose value differs per KEY of an instrument
 * (see `keyRowsCollapse`). It is set on built-ins only.
 */
export interface ReportField {
  id: string;
  label: string;
  group: ReportFieldGroup;
  kind: ReportFieldKind;
  unit?: string;
  measured?: boolean;
  perKey?: boolean;
}

function field(id: string, label: string, kind: ReportFieldKind, perKey = false): ReportField {
  return perKey ? { id, label, group: 'builtin', kind, perKey: true } : { id, label, group: 'builtin', kind };
}

const CODE = field('instrument.code', 'Instrument ID', 'text');
const AREA = field('instrument.area', 'Area', 'text');
const LOCATION = field('instrument.location', 'Location', 'text');
const INSTRUMENT_STATUS = field('instrument.status', 'Status', 'status');

/** One key of one instrument, at present (the latest reading of that key). */
const LATEST_PER_KEY: readonly ReportField[] = [
  CODE, AREA, LOCATION,
  field('key.label', 'Key', 'text', true),
  field('reading.value', 'Value', 'number', true),
  field('reading.unit', 'Unit', 'text', true),
  field('reading.status', 'Status', 'status', true),
  field('reading.ts', 'Reading time', 'datetime', true),
];

/**
 * Each widget type's BUILT-IN fields, in the order the built-in template
 * prints them. Labels are the widget's own column words where it has columns.
 *
 * WHAT ONE ROW IS — the contract the row builder (web, `widget-report-data.ts`)
 * and the PDF builder (`widget-report.ts`) both implement:
 *
 *  - `value_cards`, `latest_table`, `gauge`, `comparison_bar`: one row per KEY
 *    of each instrument (its latest reading of that key). While the template
 *    shows NO `perKey` field, one row per INSTRUMENT instead, its keys side by
 *    side as `key:<name>` columns (`keyRowsCollapse`).
 *  - `timeseries_table`: one row per stored instant of an instrument per KEY;
 *    with no `perKey` field shown, one row per instant (the widget's own shape).
 *  - `trend_chart`: one row per plotted SERIES (an instrument's key) with the
 *    server's range figures for the window (min / max / average / readings).
 *  - `bar_chart`: one row per BAR — a bucket of a series.
 *  - `alarm_table`: one row per alarm. `pie_chart`: one row per slice.
 *    `alarm_counts`: one row per figure (Active, Unacknowledged, Active by type).
 *  - `status_grid`, `instrument_list`: one row per instrument.
 *  - `text_card`, `floorplan`: no fields — they print what they show (the text;
 *    the floor plan as an image) with the chrome.
 *
 * A `key:<name>` column on an instrument's row is that instrument's value of
 * the key at the row's time (the latest; the row's instant for the time
 * series); an `attr:<name>` column is the instrument's attribute. On a row with
 * no single instrument (a bar of "all instruments", a slice, a figure) both are
 * empty. A column the profile's catalogue does not have prints empty cells and
 * is named under the table as not available — never dropped, never invented.
 */
export const WIDGET_REPORT_FIELDS: Record<WidgetType, readonly ReportField[]> = {
  value_cards: LATEST_PER_KEY,
  latest_table: LATEST_PER_KEY,
  trend_chart: [
    CODE, LOCATION,
    field('key.label', 'Key', 'text'),
    field('reading.unit', 'Unit', 'text'),
    field('summary.min', 'Minimum', 'number'),
    field('summary.max', 'Maximum', 'number'),
    field('summary.avg', 'Average', 'number'),
    field('summary.count', 'Readings', 'number'),
  ],
  timeseries_table: [
    field('reading.ts', 'Time', 'datetime'),
    CODE,
    field('key.label', 'Key', 'text', true),
    field('reading.value', 'Value', 'number', true),
    field('reading.unit', 'Unit', 'text', true),
  ],
  alarm_table: [
    CODE,
    field('alarm.type', 'Type', 'text'),
    LOCATION,
    field('alarm.raisedAt', 'Raised', 'datetime'),
    field('alarm.value', 'Generated value', 'text'),
    field('alarm.limit', 'Limit', 'text'),
    field('alarm.clearedAt', 'Cleared', 'datetime'),
    field('alarm.clearedValue', 'Cleared value', 'text'),
    field('alarm.status', 'Status', 'status'),
    field('alarm.acknowledgedBy', 'Acknowledged by', 'text'),
    field('alarm.acknowledgedAt', 'Acknowledged at', 'datetime'),
  ],
  gauge: LATEST_PER_KEY,
  bar_chart: [
    field('bucket.ts', 'Period', 'datetime'),
    field('series.label', 'Series', 'text'),
    field('bucket.value', 'Value', 'number'),
    field('reading.unit', 'Unit', 'text'),
    field('bucket.readings', 'Readings', 'number'),
  ],
  comparison_bar: LATEST_PER_KEY,
  pie_chart: [
    field('slice.label', 'Category', 'text'),
    field('slice.count', 'Count', 'number'),
    { ...field('slice.share', 'Share', 'number'), unit: '%' },
  ],
  alarm_counts: [
    field('count.label', 'Alarms', 'text'),
    field('count.value', 'Count', 'number'),
  ],
  status_grid: [CODE, AREA, LOCATION, INSTRUMENT_STATUS],
  instrument_list: [CODE, AREA, LOCATION, INSTRUMENT_STATUS, field('instrument.lastSeen', 'Last seen', 'datetime')],
  text_card: [],
  floorplan: [],
};

/** The types with a field catalogue (spec §4) — every type but the text card and the floor plan. */
export const REPORTABLE_WIDGET_TYPES: readonly WidgetType[] = WIDGET_TYPES.filter((t) => WIDGET_REPORT_FIELDS[t].length > 0);

/**
 * Does a template of this widget type print the profile's `key:` / `attr:`
 * fields? Not for a type with no field catalogue (text card, floor plan), and
 * not for `pie_chart` / `alarm_counts`: their rows (a slice, a figure) are never
 * one instrument, so such a cell is always empty (the row-grain contract). The
 * server's catalogue applies it (`GET /api/report-templates/catalogue`), so the
 * editor's preview and the download read the SAME field list — never filter
 * the catalogue a second time in the browser.
 */
export function widgetTypeTakesProfileFields(t: WidgetType): boolean {
  return REPORTABLE_WIDGET_TYPES.includes(t) && t !== 'pie_chart' && t !== 'alarm_counts';
}

/** The types printed in landscape by default: the three wide tables. */
const LANDSCAPE_TYPES: readonly WidgetType[] = ['latest_table', 'timeseries_table', 'alarm_table'];

/**
 * Each PAGE kind's built-in fields (spec §6), in the order today's PDF prints
 * them, headed as today's PDF heads them. Fresh `field()` objects, never the
 * widget ones: a shared id (`alarm.type`, `instrument.code` …) may carry another
 * label here, and a column is checked against its OWN kind's list. A cell is
 * the page's formatted STRING (decimals, `Error` / `OL`, `NA`, the redaction
 * note) — `kind` describes the value for the editor's preview; a template's
 * `decimals` never re-rounds a page's text (review C1). No page field is
 * `perKey`, so `keyRowsCollapse` is false for every page kind.
 *
 * WHAT ONE ROW IS:
 *  - `page:data-report`: one stored instant (or schedule slot) of ONE
 *    instrument; the report is one section per instrument.
 *  - `page:trend`: no rows — the chart image(s) with the chrome.
 *  - `page:instrument-alarms`: one alarm of ONE instrument.
 *  - `page:alarms`: one alarm, any instrument. `page:audit-trail`: one record.
 */
export const PAGE_REPORT_FIELDS: Record<PageTemplateKind, readonly ReportField[]> = {
  'page:data-report': [
    field('record.date', 'DATE', 'datetime'),
    field('record.time', 'TIME', 'datetime'),
    field('record.temperature', 'TEMPERATURE (°C)', 'number'),
    field('record.humidity', 'RELATIVE HUMIDITY(%)', 'number'),
  ],
  'page:trend': [],
  'page:instrument-alarms': [
    field('alarm.type', 'Type', 'text'),
    field('alarm.raisedAt', 'Raised', 'datetime'),
    field('alarm.value', 'Value', 'text'),
    field('alarm.limit', 'Limit', 'text'),
    field('alarm.clearedAt', 'Cleared', 'datetime'),
    field('alarm.status', 'Status', 'status'),
  ],
  // The placement columns FIRST, as today's `reportHead` prints them
  // (`EXTRA_COLUMNS[level]` then `ALARM_REPORT_HEAD`) — ruling T1-F.
  'page:alarms': [
    field('instrument.code', 'INSTRUMENT ID', 'text'),
    field('instrument.area', 'AREA', 'text'),
    field('instrument.location', 'LOCATION', 'text'),
    field('alarm.date', 'DATE', 'datetime'),
    field('alarm.time', 'TIME', 'datetime'),
    field('alarm.description', 'DESCRIPTION', 'text'),
    field('alarm.uom', 'UOM', 'text'),
    field('alarm.pv', 'PV VALUE', 'number'),
    field('alarm.high', 'HIGH LIMIT', 'number'),
    field('alarm.low', 'LOW LIMIT', 'number'),
  ],
  'page:audit-trail': [
    field('audit.timestamp', 'Timestamp', 'datetime'),
    field('audit.action', 'Action', 'text'),
    field('audit.user', 'User', 'text'),
    field('audit.role', 'Role', 'text'),
    field('audit.targetType', 'Target Type', 'text'),
    field('audit.description', 'Description', 'text'),
    field('audit.ip', 'IP Address', 'text'),
  ],
};

/** A kind's built-in fields: a widget type's `WIDGET_REPORT_FIELDS`, a page kind's `PAGE_REPORT_FIELDS`. */
export function REPORT_TEMPLATE_FIELDS(kind: TemplateKind): readonly ReportField[] {
  return isPageTemplateKind(kind) ? PAGE_REPORT_FIELDS[kind] : WIDGET_REPORT_FIELDS[kind];
}

// ── Placeholders ────────────────────────────────────────────────────────────

/** The ten a widget report supplies (2026-11-02) — the first ten of the vocabulary. */
const WIDGET_PLACEHOLDERS = [
  'dashboard', 'widget', 'profile', 'from', 'to', 'period', 'date', 'user', 'instrumentCount', 'selection',
] as const;

/**
 * The values a title, a subtitle, a footer line or an info row can name —
 * `{dashboard}` in text, `dashboard` as an info row's source. APPENDED to,
 * never renamed: stored documents name them. The page reports' names
 * (2026-11-03): `instrument` (its code), `block`, `area`, `location`, the
 * period's `fromDate` / `fromTime` / `toDate` / `toTime`, the Data Report's
 * `interval`, `mkt`, `tempLimit`, `rhLimit`, `extremes`, the Audit Trail's
 * `recordCount` and `search`, the trend's `series` (its slot label) and the
 * Alarm Report's `level`. Which kind supplies which: `TEMPLATE_KIND_SPECS`.
 */
export const REPORT_PLACEHOLDERS = [
  ...WIDGET_PLACEHOLDERS,
  'instrument', 'block', 'area', 'location', 'fromDate', 'fromTime', 'toDate', 'toTime', 'interval', 'mkt',
  'tempLimit', 'rhLimit', 'extremes', 'recordCount', 'search', 'series', 'level',
] as const;
export type Placeholder = (typeof REPORT_PLACEHOLDERS)[number];

export function isPlaceholder(v: unknown): v is Placeholder {
  return typeof v === 'string' && (REPORT_PLACEHOLDERS as readonly string[]).includes(v);
}

const PLACEHOLDER_TOKEN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

/**
 * `{name}` → its value; an absent, blank or unknown name prints `—`. ONE pass:
 * a value that itself contains `{to}` is printed as typed. Only the names of
 * `REPORT_PLACEHOLDERS` are looked up, and only as the object's own values, so
 * `{toString}` is `—`, not a function. Text that is not `{identifier}` is left
 * alone.
 */
export function substitutePlaceholders(text: string, values: Partial<Record<Placeholder, string>>): string {
  return text.replace(PLACEHOLDER_TOKEN, (_token, name: string) => {
    if (!isPlaceholder(name) || !Object.prototype.hasOwnProperty.call(values, name)) return REPORT_VALUE_MISSING;
    const v = values[name];
    return typeof v === 'string' && v.trim() !== '' ? v : REPORT_VALUE_MISSING;
  });
}

// ── The kinds, described ────────────────────────────────────────────────────

/**
 * Who a kind's templates belong to: `'profile'` — one instrument profile (every
 * widget type, and the three page reports about one instrument); `'application'`
 * — the whole application, `profile_id` NULL (the Alarm Report and the Audit
 * Trail, whose rows carry no profile).
 */
export type TemplateKindScope = 'profile' | 'application';

/**
 * Which of the profile's catalogue fields a kind's template may print: `'all'`
 * (`key:` and `attr:`), `'attributes'` (`attr:` only), `'none'`.
 */
export type TemplateProfileFields = 'all' | 'attributes' | 'none';

export interface TemplateKindSpec {
  /** What the kind is called (a widget type's label; a page report's name). */
  label: string;
  scope: TemplateKindScope;
  profileFields: TemplateProfileFields;
  /** The built-in fields — `REPORT_TEMPLATE_FIELDS(kind)`. */
  fields: readonly ReportField[];
  /** The placeholders the kind SUPPLIES; the editor offers only these. Another prints `—`. */
  placeholders: readonly Placeholder[];
  /** The built-in prints landscape. */
  landscape: boolean;
  typography: 'default' | 'data-report';
}

/** What every instrument page report supplies: the instrument's placement, the period, the reader. */
const INSTRUMENT_PAGE_PLACEHOLDERS: readonly Placeholder[] = [
  'instrument', 'block', 'area', 'location', 'fromDate', 'fromTime', 'toDate', 'toTime',
  'from', 'to', 'period', 'date', 'user', 'profile',
];

/** A page kind's spec (spec §6). */
const PAGE_TEMPLATE_KIND_SPECS: Record<PageTemplateKind, Omit<TemplateKindSpec, 'fields'>> = {
  'page:data-report': {
    label: 'Data Report', scope: 'profile', profileFields: 'attributes',
    placeholders: [...INSTRUMENT_PAGE_PLACEHOLDERS, 'tempLimit', 'rhLimit', 'extremes', 'interval', 'mkt'],
    landscape: false, typography: 'data-report',
  },
  'page:trend': {
    label: 'Instrument Trend', scope: 'profile', profileFields: 'attributes',
    placeholders: [...INSTRUMENT_PAGE_PLACEHOLDERS, 'series'],
    landscape: false, typography: 'default',
  },
  'page:instrument-alarms': {
    label: 'Instrument Alarms', scope: 'profile', profileFields: 'attributes',
    placeholders: INSTRUMENT_PAGE_PLACEHOLDERS,
    landscape: false, typography: 'default',
  },
  'page:alarms': {
    label: 'Alarm Report', scope: 'application', profileFields: 'none',
    placeholders: ['fromDate', 'fromTime', 'toDate', 'toTime', 'from', 'to', 'period', 'recordCount', 'search', 'level', 'date', 'user'],
    landscape: false, typography: 'default',
  },
  'page:audit-trail': {
    label: 'Audit Trail', scope: 'application', profileFields: 'none',
    placeholders: ['period', 'search', 'recordCount', 'from', 'to', 'date', 'user'],
    landscape: true, typography: 'default',
  },
};

/**
 * The ONE description of every template kind. The widget half is BUILT from
 * `WIDGET_TYPE_SPECS` (label), `WIDGET_REPORT_FIELDS`, `widgetTypeTakesProfileFields`
 * and `LANDSCAPE_TYPES` — those stay the source and are not typed again; the
 * page half is `PAGE_TEMPLATE_KIND_SPECS` with `PAGE_REPORT_FIELDS`.
 */
export const TEMPLATE_KIND_SPECS: Readonly<Record<TemplateKind, TemplateKindSpec>> = Object.fromEntries([
  ...WIDGET_TYPES.map((t): [TemplateKind, TemplateKindSpec] => [t, {
    label: WIDGET_TYPE_SPECS[t].label,
    scope: 'profile',
    profileFields: widgetTypeTakesProfileFields(t) ? 'all' : 'none',
    fields: WIDGET_REPORT_FIELDS[t],
    placeholders: WIDGET_PLACEHOLDERS,
    landscape: LANDSCAPE_TYPES.includes(t),
    typography: 'default',
  }]),
  ...PAGE_TEMPLATE_KINDS.map((k): [TemplateKind, TemplateKindSpec] => [k, { ...PAGE_TEMPLATE_KIND_SPECS[k], fields: PAGE_REPORT_FIELDS[k] }]),
]) as Record<TemplateKind, TemplateKindSpec>;

/** Which profile catalogue fields a kind's template may print (`widgetTypeTakesProfileFields` agrees for a widget type). */
export function templateKindTakesProfileFields(kind: TemplateKind): TemplateProfileFields {
  return TEMPLATE_KIND_SPECS[kind].profileFields;
}

/** Whether a kind's templates belong to a profile or to the whole application. */
export function templateKindScope(kind: TemplateKind): TemplateKindScope {
  return TEMPLATE_KIND_SPECS[kind].scope;
}

/** What a kind is called. */
export function templateKindLabel(kind: TemplateKind): string {
  return TEMPLATE_KIND_SPECS[kind].label;
}

// ── Logo ────────────────────────────────────────────────────────────────────

const LOGO_DATA_URL = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/;
/** The base64 of each format's first bytes: PNG 89 50 4E 47 0D 0A 1A 0A, JPEG FF D8 FF. */
const PNG_MAGIC = 'iVBORw0KGgo';
const JPEG_MAGIC = '/9j/';

/**
 * What image a logo `data:` URL HOLDS, by its bytes — never by its label: a
 * PNG uploaded under a `.jpg` name is a PNG. `null` = not a base64 PNG / JPEG
 * data URL. The ONE rule: the schema refuses what this cannot name, and the
 * PDF draws in the format it names.
 */
export function reportLogoFormat(dataUrl: string): 'PNG' | 'JPEG' | null {
  const m = LOGO_DATA_URL.exec(dataUrl);
  if (!m) return null;
  if (m[2].startsWith(PNG_MAGIC)) return 'PNG';
  if (m[2].startsWith(JPEG_MAGIC)) return 'JPEG';
  return null;
}

// ── The document ────────────────────────────────────────────────────────────

export type ReportLogoMode = 'branding' | 'custom' | 'none';
export const REPORT_LOGO_MODES = ['branding', 'custom', 'none'] as const;

export interface ReportTemplateColumn {
  /** A catalogue field id (`REPORT_TEMPLATE_FIELDS(kind)`, `key:<name>`, `attr:<name>`). */
  id: string;
  /** What the column is called on the report. */
  heading: string;
  show: boolean;
  /** For a number: the digits after the point (0..6). */
  decimals?: number;
  /** For a number: printed beside the heading. */
  unit?: string;
}

export interface ReportTemplateInfoRow {
  label: string;
  /** A placeholder name (`dashboard`, `instrumentCount` …) or `attr:<key>` (a one-instrument report). */
  source: string;
}

export interface ReportTemplateDocument {
  version: 1;
  header: {
    /** A template: placeholders are substituted. */
    title: string;
    subtitle?: string;
    /** Blank = Configuration → Report Page Titles / Branding. */
    companyName?: string;
    appName?: string;
    showAppName: boolean;
    logo: { mode: ReportLogoMode; dataUrl?: string };
    /** `#rrggbb`; absent = the theme's. */
    accentColor?: string;
  };
  infoBlock: ReportTemplateInfoRow[];
  columns: ReportTemplateColumn[];
  footer: {
    text?: string;
    showPageNumbers: boolean;
    showPrintedBy: boolean;
    showPrintedAt: boolean;
    signatureLine: boolean;
  };
  page: { orientation: 'portrait' | 'landscape'; typography: 'default' | 'data-report' };
  notes: { remarksLabel?: string; legend?: string };
}

const BUILTIN_FIELD_ID = /^[a-z]+\.[A-Za-z]+$/;
const CATALOGUE_FIELD_ID = /^(key|attr):\S/;
const ATTRIBUTE_SOURCE = /^attr:\S/;

const optionalText = (max: number, what: string) =>
  z.string().trim().max(max, `${what} must be ${max} characters or fewer`).optional();

const logoSchema = z.object({
  mode: z.enum(REPORT_LOGO_MODES),
  dataUrl: z.string().optional(),
}).superRefine((logo, ctx) => {
  if (logo.dataUrl === undefined) {
    if (logo.mode === 'custom') ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataUrl'], message: 'Upload a logo image, or choose Branding or None' });
    return;
  }
  // Size first: a million-character string is not worth a regex, and the size is the reason.
  if (logo.dataUrl.length > REPORT_TEMPLATE_LOGO_MAX) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataUrl'], message: REPORT_TEMPLATE_LOGO_TOO_LARGE });
    return;
  }
  const payload = LOGO_DATA_URL.exec(logo.dataUrl)?.[2];
  if (payload === undefined || reportLogoFormat(logo.dataUrl) === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataUrl'], message: 'The logo must be a PNG or JPEG image' });
  } else if (payload.length % 4 !== 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['dataUrl'], message: 'The logo image is incomplete' });
  }
});

const columnSchema = z.object({
  id: z.string().max(REPORT_FIELD_ID_MAX, 'Not a field id')
    .refine((id) => BUILTIN_FIELD_ID.test(id) || CATALOGUE_FIELD_ID.test(id), 'Not a field id'),
  heading: z.string().trim()
    .min(1, 'A column needs a heading')
    .max(REPORT_TEMPLATE_HEADING_MAX, `A heading must be ${REPORT_TEMPLATE_HEADING_MAX} characters or fewer`),
  show: z.boolean(),
  decimals: z.number().int().min(0, 'Decimals must be between 0 and 6').max(6, 'Decimals must be between 0 and 6').optional(),
  unit: optionalText(16, 'A unit'),
});

const infoRowSchema = z.object({
  label: z.string().trim().min(1, 'An information row needs a label').max(60, 'A label must be 60 characters or fewer'),
  source: z.string().max(REPORT_FIELD_ID_MAX, 'Not a value this report can print')
    .refine((s) => isPlaceholder(s) || ATTRIBUTE_SOURCE.test(s), 'Not a value this report can print'),
});

/** The ONE validator of a template document. Name-less: the row has the name. */
export const reportTemplateDocumentSchema: z.ZodType<ReportTemplateDocument> = z.object({
  version: z.literal(REPORT_TEMPLATE_DOCUMENT_VERSION),
  header: z.object({
    title: z.string().trim()
      .min(1, 'A report needs a title')
      .max(REPORT_TEMPLATE_TITLE_MAX, `A title must be ${REPORT_TEMPLATE_TITLE_MAX} characters or fewer`),
    subtitle: optionalText(REPORT_TEMPLATE_TEXT_MAX, 'A subtitle'),
    companyName: optionalText(120, 'A company name'),
    appName: optionalText(120, 'An application name'),
    showAppName: z.boolean(),
    logo: logoSchema,
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'A colour is #rrggbb').optional(),
  }),
  infoBlock: z.array(infoRowSchema)
    .max(REPORT_TEMPLATE_INFO_ROWS_MAX, `At most ${REPORT_TEMPLATE_INFO_ROWS_MAX} information rows`),
  columns: z.array(columnSchema)
    .max(REPORT_TEMPLATE_COLUMNS_MAX, `At most ${REPORT_TEMPLATE_COLUMNS_MAX} columns`)
    .superRefine((cols, ctx) => {
      const seen = new Set<string>();
      cols.forEach((c, n) => {
        if (seen.has(c.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [n, 'id'], message: `"${c.id}" is a column twice` });
        seen.add(c.id);
      });
    }),
  footer: z.object({
    text: optionalText(REPORT_TEMPLATE_TEXT_MAX, 'The footer text'),
    showPageNumbers: z.boolean(),
    showPrintedBy: z.boolean(),
    showPrintedAt: z.boolean(),
    signatureLine: z.boolean(),
  }),
  page: z.object({
    orientation: z.enum(['portrait', 'landscape']),
    typography: z.enum(['default', 'data-report']),
  }),
  notes: z.object({
    remarksLabel: optionalText(60, 'The remarks label'),
    legend: optionalText(REPORT_TEMPLATE_LEGEND_MAX, 'The legend'),
  }),
});

// ── The built-in template ───────────────────────────────────────────────────

/**
 * The page reports' instrument header, in today's order — Block / Area /
 * Location / Inst ID against Start Date / Start Time / End Date / End Time, two
 * per line (the block every instrument page report printed before templates).
 * The Data Report's parameter block opens with the same eight.
 */
const INSTRUMENT_HEADER_ROWS: readonly ReportTemplateInfoRow[] = [
  { label: 'Block', source: 'block' }, { label: 'Start Date', source: 'fromDate' },
  { label: 'Area', source: 'area' }, { label: 'Start Time', source: 'fromTime' },
  { label: 'Location', source: 'location' }, { label: 'End Date', source: 'toDate' },
  { label: 'Inst ID', source: 'instrument' }, { label: 'End Time', source: 'toTime' },
];

/**
 * Each page kind's header and information rows — TODAY's layout (spec §6), so
 * a page report drawn from its built-in prints what the page printed before
 * templates. No `notes.legend` on any of them (ruling P-1): the Data Report and
 * the Alarm Report pass today's STRUCTURED legend themselves, and only a saved
 * template's own legend text replaces it. The Audit Trail's subtitle prints
 * `Search: —` with no search (ruling P-2 — the ONE accepted difference from
 * today, which left the segment out).
 */
const PAGE_BUILTIN_CHROME: Record<PageTemplateKind, { header: Pick<ReportTemplateDocument['header'], 'title' | 'subtitle' | 'showAppName'>; infoBlock: readonly ReportTemplateInfoRow[] }> = {
  'page:data-report': {
    header: { title: 'Temperature and RH Data Report', showAppName: false },
    infoBlock: [
      ...INSTRUMENT_HEADER_ROWS,
      { label: 'Temp. Limit', source: 'tempLimit' }, { label: 'RH Limit', source: 'rhLimit' },
      { label: 'Extremes', source: 'extremes' }, { label: 'Interval', source: 'interval' },
      { label: 'MKT', source: 'mkt' },
    ],
  },
  'page:trend': {
    header: {
      title: 'Instrument Trend — {series}',
      subtitle: '{instrument} — {series}. The chart as seen on screen. The Instrument Time Series report covers the same readings unaveraged.',
      showAppName: true,
    },
    infoBlock: INSTRUMENT_HEADER_ROWS,
  },
  'page:instrument-alarms': {
    header: { title: 'Instrument Alarms', subtitle: '{instrument}', showAppName: true },
    infoBlock: INSTRUMENT_HEADER_ROWS,
  },
  'page:alarms': {
    header: { title: 'ALARM REPORT', showAppName: true },
    infoBlock: [
      { label: 'Start Date', source: 'fromDate' }, { label: 'Start Time', source: 'fromTime' },
      { label: 'End Date', source: 'toDate' }, { label: 'End Time', source: 'toTime' },
    ],
  },
  'page:audit-trail': {
    header: {
      title: 'Audit Trail',
      subtitle: 'Period: {period}  |  Search: {search}  |  Total: {recordCount} record(s)  |  21 CFR Part 11 Compliant',
      showAppName: true,
    },
    infoBlock: [],
  },
};

/**
 * The shipped document of a kind. Every built-in field shown, headed by its
 * label; the branding logo; page numbers, printed by and printed at in the
 * footer; the kind's orientation and typography (`TEMPLATE_KIND_SPECS`).
 *  - A widget type: title `{widget}`, subtitle `{dashboard} · {period}`, the
 *    Selection / Instruments rows (none on a text card).
 *  - A page kind: today's page layout (`PAGE_BUILTIN_CHROME`).
 * A FRESH object on every call — the editor starts new templates from it and
 * edits it in place.
 */
export function builtinReportTemplate(kind: TemplateKind): ReportTemplateDocument {
  const spec = TEMPLATE_KIND_SPECS[kind];
  const page: ReportTemplateDocument['page'] = { orientation: spec.landscape ? 'landscape' : 'portrait', typography: spec.typography };
  const columns = spec.fields.map((f) => ({ id: f.id, heading: f.label, show: true }));
  const footer = { showPageNumbers: true, showPrintedBy: true, showPrintedAt: true, signatureLine: false };
  if (isPageTemplateKind(kind)) {
    const chrome = PAGE_BUILTIN_CHROME[kind];
    return {
      version: REPORT_TEMPLATE_DOCUMENT_VERSION,
      header: { ...chrome.header, logo: { mode: 'branding' } },
      infoBlock: chrome.infoBlock.map((r) => ({ ...r })),
      columns,
      footer,
      page,
      notes: {},
    };
  }
  const infoBlock: ReportTemplateInfoRow[] = kind === 'text_card'
    ? []
    : [{ label: 'Selection', source: 'selection' }, { label: 'Instruments', source: 'instrumentCount' }];
  return {
    version: REPORT_TEMPLATE_DOCUMENT_VERSION,
    header: {
      title: '{widget}',
      subtitle: '{dashboard} · {period}',
      showAppName: true,
      logo: { mode: 'branding' },
    },
    infoBlock,
    columns,
    footer,
    page,
    notes: {},
  };
}

/**
 * The ONE forgiving reader of a stored document: one that passes the schema is
 * returned as parsed; anything else — absent, corrupt, another version — is the
 * kind's built-in. Never throws; never mixes a broken document with the
 * built-in field by field.
 */
export function coerceReportTemplateDocument(value: unknown, kind: TemplateKind): ReportTemplateDocument {
  const r = reportTemplateDocumentSchema.safeParse(value);
  return r.success ? r.data : builtinReportTemplate(kind);
}

/**
 * Does this report print ONE ROW PER INSTRUMENT (per instant for the time
 * series) instead of its type's row per KEY? True only for the per-key types
 * (`WIDGET_REPORT_FIELDS` entries marked `perKey`) when the document shows none
 * of those fields — the keys then sit side by side as `key:<name>` columns.
 * Every other kind keeps its own row (a series, a bar, an alarm, a page
 * report's record …): false. No page field is `perKey`, so false for every page
 * kind by construction.
 */
export function keyRowsCollapse(kind: TemplateKind, document: ReportTemplateDocument): boolean {
  const perKey = new Set(REPORT_TEMPLATE_FIELDS(kind).filter((f) => f.perKey).map((f) => f.id));
  if (perKey.size === 0) return false;
  return !document.columns.some((c) => c.show && perKey.has(c.id));
}

// ── Create / update bodies ──────────────────────────────────────────────────

/**
 * A new template. `profileId` is required for a `'profile'` kind and must be
 * absent for an `'application'` one — the API enforces that (400
 * `SCOPE_MISMATCH`) and re-checks on every write; the schema leaves it optional
 * so the API's own answer is the one a caller sees.
 */
export const reportTemplateCreateSchema = z.object({
  profileId: z.string().uuid('Not a profile id').optional(),
  kind: z.enum(TEMPLATE_KINDS),
  name: z.string().trim()
    .min(1, 'A template needs a name')
    .max(REPORT_TEMPLATE_NAME_MAX, `A name must be ${REPORT_TEMPLATE_NAME_MAX} characters or fewer`),
  isDefault: z.boolean().default(false),
  document: reportTemplateDocumentSchema,
});
export type ReportTemplateCreate = z.infer<typeof reportTemplateCreateSchema>;

/** A rename and / or a new document. The profile and the kind never change. */
export const reportTemplateUpdateSchema = reportTemplateCreateSchema.pick({ name: true, document: true }).partial();
export type ReportTemplateUpdate = z.infer<typeof reportTemplateUpdateSchema>;

// ── The wire row ────────────────────────────────────────────────────────────

/**
 * A template as every `/api/report-templates` route returns it (the list,
 * `GET /:id`, the writes, `resolve`'s `template`). `document` always passes the
 * schema: the server reads a stored one through `coerceReportTemplateDocument`.
 * `updatedBy` is the USERNAME of the last writer. `profileId` is `null` for an
 * application-wide kind (`templateKindScope(kind) === 'application'`).
 */
export interface ReportTemplateRow {
  id: string;
  profileId: string | null;
  kind: TemplateKind;
  name: string;
  isDefault: boolean;
  document: ReportTemplateDocument;
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

/**
 * The most instrument ids `GET /api/report-templates/resolve` takes (as many as
 * `telemetry-overview`; a GET URL cannot carry many more). More is a 400.
 */
export const REPORT_TEMPLATE_RESOLVE_IDS_MAX = 200;

// ── Report kinds ────────────────────────────────────────────────────────────

/** The download-policy kind of a widget type's report (`REPORT_KINDS`). */
export const WIDGET_REPORT_KIND = <T extends WidgetType>(t: T) => `widget:${t}` as const;
export type WidgetReportKind = `widget:${WidgetType}`;

/** The audit `reportType` of a widget type's report: `Widget: <its label>`. */
export function widgetReportType(t: WidgetType): string {
  return `Widget: ${WIDGET_TYPE_SPECS[t].label}`;
}
