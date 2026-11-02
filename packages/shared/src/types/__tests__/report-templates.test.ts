import { describe, it, expect } from 'vitest';
import { WIDGET_TYPES, WIDGET_TYPE_SPECS, type WidgetType } from '../dashboard-widgets.js';
import {
  REPORT_TEMPLATE_DOCUMENT_VERSION, REPORT_TEMPLATE_LOGO_MAX, REPORTABLE_WIDGET_TYPES, WIDGET_REPORT_FIELDS,
  REPORT_TEMPLATE_LOGO_IMAGE_KB, REPORT_TEMPLATE_LOGO_TOO_LARGE,
  REPORT_PLACEHOLDERS, REPORT_VALUE_MISSING, reportTemplateDocumentSchema, reportTemplateCreateSchema,
  reportTemplateUpdateSchema, builtinReportTemplate, substitutePlaceholders, coerceReportTemplateDocument,
  WIDGET_REPORT_KIND, widgetReportType, reportLogoFormat, keyRowsCollapse, type ReportTemplateDocument,
  widgetTypeTakesProfileFields,
} from '../report-templates.js';
import {
  REPORT_KINDS, coerceReportDownloads, isReportKind, reportKindSettingKeys, reportTypeMatchesKind,
  REPORT_KIND_POLICY_DEFAULT,
} from '../report-downloads.js';
import { AUDIT_ACTIONS } from '../audit-actions.js';
import { AUDIT_TEMPLATE_DEFAULTS } from '../audit-templates.js';

/**
 * Report templates per instrument profile × widget type (spec
 * docs/superpowers/specs/2026-11-02-widget-report-templates-design.md §4, §6,
 * §8). The shared contract: the document schema, each widget type's built-in
 * fields and template, placeholder substitution, the ONE forgiving reader and
 * the `widget:<type>` report kinds.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDA==';

/** A valid built-in, deep-copied, with `patch` applied by the caller. */
function doc(type: WidgetType = 'gauge'): ReportTemplateDocument {
  return builtinReportTemplate(type);
}

function issues(value: unknown): string[] {
  const r = reportTemplateDocumentSchema.safeParse(value);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
}

describe('the reportable widget types and their built-in fields', () => {
  it('are the twelve of spec §4; a text card and a floor plan print what they show and have no fields', () => {
    expect([...REPORTABLE_WIDGET_TYPES]).toEqual([
      'value_cards', 'latest_table', 'trend_chart', 'timeseries_table', 'alarm_table', 'gauge',
      'bar_chart', 'comparison_bar', 'pie_chart', 'alarm_counts', 'status_grid', 'instrument_list',
    ]);
    expect(WIDGET_REPORT_FIELDS.text_card).toEqual([]);
    expect(WIDGET_REPORT_FIELDS.floorplan).toEqual([]);
    // The reportable list IS the types that have fields — the two cannot disagree.
    expect([...REPORTABLE_WIDGET_TYPES]).toEqual(WIDGET_TYPES.filter((t) => WIDGET_REPORT_FIELDS[t].length > 0));
  });

  it('every field is a built-in: a namespaced id (never key: / attr:, which are the catalogue\'s), unique per type, labelled', () => {
    for (const t of WIDGET_TYPES) {
      const ids = WIDGET_REPORT_FIELDS[t].map((f) => f.id);
      expect(new Set(ids).size, t).toBe(ids.length);
      for (const f of WIDGET_REPORT_FIELDS[t]) {
        expect(f.group, `${t} ${f.id}`).toBe('builtin');
        expect(f.id, t).toMatch(/^[a-z]+\.[A-Za-z]+$/);
        expect(f.label.trim().length, `${t} ${f.id}`).toBeGreaterThan(0);
        expect(['text', 'number', 'datetime', 'status']).toContain(f.kind);
      }
    }
  });

  it('a widget that shows readings has reading fields, so its built-in report prints values for ANY profile', () => {
    for (const t of ['value_cards', 'latest_table', 'gauge', 'comparison_bar', 'timeseries_table'] as const) {
      const ids = WIDGET_REPORT_FIELDS[t].map((f) => f.id);
      expect(ids, t).toEqual(expect.arrayContaining(['instrument.code', 'key.label', 'reading.value', 'reading.unit']));
    }
    expect(WIDGET_REPORT_FIELDS.trend_chart.map((f) => f.id)).toEqual(expect.arrayContaining(['key.label', 'summary.min', 'summary.max']));
    expect(WIDGET_REPORT_FIELDS.bar_chart.map((f) => f.id)).toEqual(expect.arrayContaining(['bucket.ts', 'series.label', 'bucket.value']));
    expect(WIDGET_REPORT_FIELDS.alarm_table.map((f) => f.id)).toEqual(expect.arrayContaining(['instrument.code', 'alarm.type', 'alarm.raisedAt', 'alarm.status']));
  });
});

describe('builtinReportTemplate', () => {
  it('every widget type has one, and every one passes the document schema (empty columns included)', () => {
    for (const t of WIDGET_TYPES) {
      expect(issues(builtinReportTemplate(t)), t).toEqual([]);
    }
  });

  it('every reportable type prints ALL its built-in fields, in order, headed by their labels — and nothing else', () => {
    for (const t of REPORTABLE_WIDGET_TYPES) {
      const b = builtinReportTemplate(t);
      const fieldIds = new Set(WIDGET_REPORT_FIELDS[t].map((f) => f.id));
      for (const c of b.columns) expect(fieldIds.has(c.id), `${t} ${c.id}`).toBe(true);
      expect(b.columns).toEqual(WIDGET_REPORT_FIELDS[t].map((f) => ({ id: f.id, heading: f.label, show: true })));
    }
  });

  it('carries the chrome the brief names: title {widget}, subtitle {dashboard} · {period}, branding logo, the three footer lines', () => {
    const b = builtinReportTemplate('gauge');
    expect(b.version).toBe(REPORT_TEMPLATE_DOCUMENT_VERSION);
    expect(b.header.title).toBe('{widget}');
    expect(b.header.subtitle).toBe('{dashboard} · {period}');
    expect(b.header.logo).toEqual({ mode: 'branding' });
    expect(b.header.showAppName).toBe(true);
    expect(b.footer).toMatchObject({ showPageNumbers: true, showPrintedBy: true, showPrintedAt: true, signatureLine: false });
    expect(b.page.typography).toBe('default');
  });

  it('is landscape for the three wide tables only', () => {
    const landscape = WIDGET_TYPES.filter((t) => builtinReportTemplate(t).page.orientation === 'landscape');
    expect(landscape).toEqual(['latest_table', 'timeseries_table', 'alarm_table']);
  });

  it('returns a FRESH document each call — the editor starts new templates from it', () => {
    const a = builtinReportTemplate('latest_table');
    a.columns[0].heading = 'Changed';
    a.header.title = 'Changed';
    a.infoBlock.push({ label: 'X', source: 'date' });
    const b = builtinReportTemplate('latest_table');
    expect(b.columns[0].heading).toBe(WIDGET_REPORT_FIELDS.latest_table[0].label);
    expect(b.header.title).toBe('{widget}');
    expect(b.infoBlock).not.toContainEqual({ label: 'X', source: 'date' });
  });
});

describe('reportTemplateDocumentSchema', () => {
  it('accepts a custom PNG or JPEG logo', () => {
    const d = doc();
    d.header.logo = { mode: 'custom', dataUrl: PNG };
    expect(issues(d)).toEqual([]);
    d.header.logo = { mode: 'custom', dataUrl: JPEG };
    expect(issues(d)).toEqual([]);
  });

  it('refuses a logo over 1,000,000 characters — the size is the reason given', () => {
    const d = doc();
    const prefix = 'data:image/png;base64,iVBORw0KGgo';
    d.header.logo = { mode: 'custom', dataUrl: prefix + 'A'.repeat(REPORT_TEMPLATE_LOGO_MAX + 1 - prefix.length) };
    expect(d.header.logo.dataUrl!.length).toBe(1_000_001);
    const found = issues(d);
    expect(found).toHaveLength(1);
    expect(found[0]).toBe(`header.logo.dataUrl: ${REPORT_TEMPLATE_LOGO_TOO_LARGE}`);
  });

  // Fix wave 1: the message said "1 MB" while the cap is a million CHARACTERS
  // of base64 — an 800 KB PNG was told it was over 1 MB. The figure is now
  // derived from the cap; these pin both the words and that they are true.
  it('the size refusal states the real cap: about 730 KB of image, 1,000,000 characters as a data URL', () => {
    expect(REPORT_TEMPLATE_LOGO_IMAGE_KB).toBe(730);
    expect(REPORT_TEMPLATE_LOGO_TOO_LARGE).toBe('The logo must be about 730 KB of image or smaller (1,000,000 characters as a data URL)');
    const jpegOf = (bytes: number) => 'data:image/jpeg;base64,/9j/' + 'A'.repeat(4 * Math.ceil(bytes / 3) - 4);
    const tooLarge = (bytes: number) => {
      const d = doc();
      d.header.logo = { mode: 'custom', dataUrl: jpegOf(bytes) };
      return issues(d).some((i) => i.includes(REPORT_TEMPLATE_LOGO_TOO_LARGE));
    };
    expect(tooLarge(REPORT_TEMPLATE_LOGO_IMAGE_KB * 1024)).toBe(false);
    expect(tooLarge((REPORT_TEMPLATE_LOGO_IMAGE_KB + 10) * 1024)).toBe(true);
  });

  it('accepts the longest whole-base64 logo under the limit', () => {
    const d = doc();
    // Base64 comes in groups of four, so with the 22-character PNG prefix the
    // longest well-formed URL within 1,000,000 characters is 999,998 long.
    const prefix = 'data:image/png;base64,';
    const payload = 'iVBORw0KGgo' + 'A'.repeat(999_976 - 'iVBORw0KGgo'.length - 1) + '=';
    expect(payload.length % 4).toBe(0);
    d.header.logo = { mode: 'custom', dataUrl: prefix + payload };
    expect(d.header.logo.dataUrl!.length).toBe(999_998);
    expect(d.header.logo.dataUrl!.length).toBeLessThanOrEqual(REPORT_TEMPLATE_LOGO_MAX);
    expect(issues(d)).toEqual([]);
  });

  it('refuses an SVG data URL, any other type, and bytes that are neither a PNG nor a JPEG', () => {
    const d = doc();
    for (const dataUrl of [
      'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=',
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
      'data:image/png;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=', // SVG bytes labelled png
      'data:image/png,iVBORw0KGgo=',              // not base64
      'https://example.com/logo.png',
      'data:image/png;base64,iVBORw0KGgoAA',      // truncated: not a whole number of base64 groups
    ]) {
      d.header.logo = { mode: 'custom', dataUrl };
      expect(issues(d).length, dataUrl.slice(0, 40)).toBeGreaterThan(0);
    }
  });

  it('accepts a PNG uploaded under a JPEG label — the bytes decide the format, not the label (review focus 3)', () => {
    const d = doc();
    d.header.logo = { mode: 'custom', dataUrl: PNG.replace('image/png', 'image/jpeg') };
    expect(issues(d)).toEqual([]);
    expect(reportLogoFormat(d.header.logo.dataUrl!)).toBe('PNG');
    expect(reportLogoFormat(JPEG)).toBe('JPEG');
    expect(reportLogoFormat('data:image/png;base64,R0lGODlh')).toBeNull();
    expect(reportLogoFormat('not a url')).toBeNull();
  });

  it('refuses an Upload logo with no image', () => {
    const d = doc();
    d.header.logo = { mode: 'custom' };
    expect(issues(d).join()).toMatch(/header\.logo\.dataUrl/);
  });

  it('refuses a column with an empty heading, a duplicate column id, and a malformed id', () => {
    const d = doc();
    d.columns[0].heading = '   ';
    expect(issues(d).join()).toMatch(/^columns\.0\.heading/);

    const dup = doc();
    dup.columns.push({ ...dup.columns[0] });
    expect(issues(dup).join()).toMatch(/columns\.\d+\.id: .*twice/);

    const bad = doc();
    bad.columns.push({ id: 'Temperature', heading: 'Temperature', show: true });
    expect(issues(bad).join()).toMatch(/columns\.\d+\.id/);
  });

  it('accepts catalogue columns `key:<name>` and `attr:<name>`, with decimals 0..6 and a unit', () => {
    const d = doc();
    d.columns.push({ id: 'key:Temperature', heading: 'Temp', show: true, decimals: 1, unit: '°C' });
    d.columns.push({ id: 'attr:Location', heading: 'Room', show: false });
    expect(issues(d)).toEqual([]);
    d.columns[d.columns.length - 2].decimals = 7;
    expect(issues(d).join()).toMatch(/decimals/);
  });

  it('refuses an info block row whose source is not a placeholder or an `attr:<key>`', () => {
    const d = doc();
    d.infoBlock = [{ label: 'Dashboard', source: 'dashboard' }, { label: 'Room', source: 'attr:Location' }];
    expect(issues(d)).toEqual([]);
    for (const source of ['nope', '{dashboard}', 'key:Temperature', 'attr:', 'Dashboard']) {
      d.infoBlock = [{ label: 'X', source }];
      expect(issues(d).join(), source).toMatch(/^infoBlock\.0\.source/);
    }
    d.infoBlock = [{ label: '  ', source: 'date' }];
    expect(issues(d).join()).toMatch(/^infoBlock\.0\.label/);
  });

  it('refuses a malformed accent colour, a blank title and a version it does not know', () => {
    const d = doc();
    d.header.accentColor = '#12345';
    expect(issues(d).join()).toMatch(/accentColor/);
    d.header.accentColor = '#1a2B3c';
    expect(issues(d)).toEqual([]);
    d.header.title = ' ';
    expect(issues(d).join()).toMatch(/^header\.title/);
    expect(issues({ ...doc(), version: 2 }).length).toBeGreaterThan(0);
  });

  it('carries no name — the row has the name', () => {
    const r = reportTemplateDocumentSchema.safeParse({ ...doc(), name: 'Mine' });
    expect(r.success).toBe(true);
    expect(r.success && 'name' in r.data).toBe(false);
  });
});

describe('substitutePlaceholders', () => {
  it('fills the known placeholders and prints — for an absent one (a value card has no {to}) — review focus 4', () => {
    expect(substitutePlaceholders('{widget} {to}', { widget: 'Gauge' })).toBe('Gauge —');
    expect(REPORT_VALUE_MISSING).toBe('—');
  });

  it('every placeholder of the vocabulary is substituted', () => {
    const values = Object.fromEntries(REPORT_PLACEHOLDERS.map((p) => [p, `<${p}>`]));
    const text = REPORT_PLACEHOLDERS.map((p) => `{${p}}`).join('|');
    expect(substitutePlaceholders(text, values)).toBe(REPORT_PLACEHOLDERS.map((p) => `<${p}>`).join('|'));
  });

  it('a blank value is absent; an unknown name is —, never a property of Object (toString, constructor)', () => {
    expect(substitutePlaceholders('[{dashboard}]', { dashboard: '   ' })).toBe('[—]');
    expect(substitutePlaceholders('{nope} {toString} {constructor}', {})).toBe('— — —');
  });

  it('an unknown name is — even when the values carry it; only the vocabulary is substituted', () => {
    const loose = { widget: 'Gauge', nope: 'leaked' } as Partial<Record<string, string>>;
    expect(substitutePlaceholders('{widget} {nope}', loose)).toBe('Gauge —');
    const inherited = Object.create({ widget: 'Inherited' }) as Partial<Record<string, string>>;
    expect(substitutePlaceholders('{widget}', inherited)).toBe('—');
  });

  it('is ONE pass: a value that contains a placeholder is printed as typed, not substituted again', () => {
    expect(substitutePlaceholders('{dashboard}', { dashboard: 'Plant {to}', to: 'X' })).toBe('Plant {to}');
  });

  it('leaves text that is not a placeholder alone', () => {
    expect(substitutePlaceholders('Room { A } · 50% {} {1x}', {})).toBe('Room { A } · 50% {} {1x}');
  });
});

describe('coerceReportTemplateDocument — the ONE forgiving reader', () => {
  it('reads {} for a gauge as the gauge built-in', () => {
    expect(coerceReportTemplateDocument({}, 'gauge')).toEqual(builtinReportTemplate('gauge'));
  });

  it('reads anything unreadable as the built-in of the type asked for, and never throws', () => {
    for (const v of [undefined, null, 'x', 1, [], { version: 2 }, { ...doc('gauge'), columns: 'x' }]) {
      expect(coerceReportTemplateDocument(v, 'alarm_table')).toEqual(builtinReportTemplate('alarm_table'));
    }
  });

  it('returns a stored document that passes the schema as stored', () => {
    const d = doc('latest_table');
    d.header.title = 'Latest — {profile}';
    d.columns[1].show = false;
    d.columns.push({ id: 'key:Temperature', heading: 'Temp', show: true, decimals: 1 });
    expect(coerceReportTemplateDocument(JSON.parse(JSON.stringify(d)), 'latest_table')).toEqual(d);
  });
});

describe('the create / update bodies', () => {
  const PROFILE = '0b7f3a52-4c1e-4a4e-9a63-2f1d1c9e8a10';

  it('create: a profile, a widget type, a trimmed name, isDefault false by default, a document', () => {
    const r = reportTemplateCreateSchema.safeParse({ profileId: PROFILE, widgetType: 'gauge', name: '  Shift report  ', document: doc() });
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.name).toBe('Shift report');
      expect(r.data.isDefault).toBe(false);
    }
  });

  it('create refuses an unknown widget type, a blank or 81-character name, and a profile id that is not a uuid', () => {
    const base = { profileId: PROFILE, widgetType: 'gauge', name: 'A', document: doc() };
    expect(reportTemplateCreateSchema.safeParse({ ...base, widgetType: 'nope' }).success).toBe(false);
    expect(reportTemplateCreateSchema.safeParse({ ...base, name: '  ' }).success).toBe(false);
    expect(reportTemplateCreateSchema.safeParse({ ...base, name: 'x'.repeat(81) }).success).toBe(false);
    expect(reportTemplateCreateSchema.safeParse({ ...base, name: 'x'.repeat(80) }).success).toBe(true);
    expect(reportTemplateCreateSchema.safeParse({ ...base, profileId: 'p1' }).success).toBe(false);
  });

  it('a template may be made for every widget type, text card and floor plan included (chrome only)', () => {
    for (const t of WIDGET_TYPES) {
      expect(reportTemplateCreateSchema.safeParse({ profileId: PROFILE, widgetType: t, name: t, document: doc(t) }).success, t).toBe(true);
    }
  });

  it('update: the name and the document, each optional; the profile and the widget type cannot be changed', () => {
    expect(reportTemplateUpdateSchema.safeParse({ name: 'Renamed' }).success).toBe(true);
    expect(reportTemplateUpdateSchema.safeParse({ document: doc() }).success).toBe(true);
    const r = reportTemplateUpdateSchema.safeParse({ name: 'R', widgetType: 'pie_chart', profileId: PROFILE });
    expect(r.success && Object.keys(r.data)).toEqual(['name']);
    expect(reportTemplateUpdateSchema.safeParse({ document: { version: 1 } }).success).toBe(false);
  });
});

describe('keyRowsCollapse — what one row of a per-key report is', () => {
  it('the built-in of a per-key widget prints a row per KEY of each instrument', () => {
    for (const t of ['value_cards', 'latest_table', 'gauge', 'comparison_bar', 'timeseries_table'] as const) {
      expect(keyRowsCollapse(t, builtinReportTemplate(t)), t).toBe(false);
    }
  });

  it('a template that shows no per-key field and a `key:` column prints ONE row per instrument (per instant), keys side by side', () => {
    const d = doc('latest_table');
    d.columns = d.columns.map((c) => ({ ...c, show: ['instrument.code', 'instrument.location'].includes(c.id) }));
    d.columns.push({ id: 'key:Temperature', heading: 'Temp', show: true });
    expect(keyRowsCollapse('latest_table', d)).toBe(true);
    // A HIDDEN per-key field does not count.
    expect(d.columns.find((c) => c.id === 'reading.value')!.show).toBe(false);
  });

  it('never for a type whose rows are not per key (a trend chart\'s series, an alarm, a slice…)', () => {
    for (const t of ['trend_chart', 'bar_chart', 'alarm_table', 'pie_chart', 'alarm_counts', 'status_grid', 'instrument_list', 'text_card', 'floorplan'] as const) {
      const d = doc(t);
      d.columns = d.columns.map((c) => ({ ...c, show: false }));
      expect(keyRowsCollapse(t, d), t).toBe(false);
    }
  });
});

describe('the audit vocabulary of a template write', () => {
  it('three actions, each with a template beside the report review ones, naming only {actor} and {targetName}', () => {
    for (const a of ['REPORT_TEMPLATE_CREATED', 'REPORT_TEMPLATE_UPDATED', 'REPORT_TEMPLATE_DELETED'] as const) {
      expect(AUDIT_ACTIONS[a]).toBe(a);
      const t = AUDIT_TEMPLATE_DEFAULTS[a];
      expect(t.category, a).toBe(AUDIT_TEMPLATE_DEFAULTS.REPORT_REVIEW_REQUESTED.category);
      expect([...t.placeholders].sort(), a).toEqual(['actor', 'targetName']);
      expect(t.template.match(/\{[A-Za-z]+\}/g)!.sort(), a).toEqual(['{actor}', '{targetName}']);
    }
  });
});

describe('widget report kinds', () => {
  it('WIDGET_REPORT_KIND names the kind; widgetReportType is "Widget: <the type\'s label>"', () => {
    expect(WIDGET_REPORT_KIND('gauge')).toBe('widget:gauge');
    expect(widgetReportType('gauge')).toBe('Widget: Gauge');
    for (const t of WIDGET_TYPES) expect(widgetReportType(t)).toBe(`Widget: ${WIDGET_TYPE_SPECS[t].label}`);
  });

  it('pins every widget type\'s label — it is the audit reportType of every widget report, stored on approved requests', () => {
    expect(Object.fromEntries(WIDGET_TYPES.map((t) => [t, WIDGET_TYPE_SPECS[t].label]))).toEqual({
      value_cards: 'Value cards',
      latest_table: 'Latest values table',
      trend_chart: 'Trend chart',
      timeseries_table: 'Time series table',
      alarm_table: 'Alarm table',
      gauge: 'Gauge',
      bar_chart: 'Bar chart',
      comparison_bar: 'Comparison bars',
      pie_chart: 'Pie chart',
      alarm_counts: 'Alarm counts',
      status_grid: 'Status grid',
      instrument_list: 'Instrument list',
      text_card: 'Text card',
      floorplan: 'Floor plan',
    });
  });

  it('REPORT_KINDS has 22 entries: the eight as they were, then one per widget type in WIDGET_TYPES order', () => {
    expect(REPORT_KINDS).toHaveLength(22);
    expect(REPORT_KINDS.slice(0, 8).map((k) => k.key)).toEqual(['data-report', 'time-series', 'trend-header', 'temperature-trend', 'humidity-trend', 'instrument-alarms', 'alarms', 'audit-trail']);
    expect(REPORT_KINDS.slice(8).map((k) => k.key)).toEqual(WIDGET_TYPES.map((t) => `widget:${t}`));
  });

  it('widget:gauge maps to "Widget: Gauge", its own setting prefix, no inheritance, a label and a hint', () => {
    const k = REPORT_KINDS.find((x) => x.key === 'widget:gauge')!;
    expect(k).toEqual({
      key: 'widget:gauge', reportType: 'Widget: Gauge', settingPrefix: 'widgetGauge', inheritsFrom: null,
      label: 'Widget — Gauge', hint: 'The Download report on the Gauge widget.',
    });
    expect(REPORT_KINDS.find((x) => x.key === 'widget:timeseries_table')!.settingPrefix).toBe('widgetTimeseriesTable');
    // No article to get wrong in front of a label ("a Alarm counts", fix wave 1).
    expect(REPORT_KINDS.find((x) => x.key === 'widget:alarm_counts')!.hint).toBe('The Download report on the Alarm counts widget.');
    expect(reportTypeMatchesKind('widget:gauge', 'Widget: Gauge')).toBe(true);
    expect(reportTypeMatchesKind('widget:gauge', 'Widget: Pie chart')).toBe(false);
    expect(isReportKind('widget:gauge')).toBe(true);
    expect(isReportKind('widget:nope')).toBe(false);
    expect(reportKindSettingKeys('widget:pie_chart')).toEqual({ mode: 'widgetPieChartMode', remarks: 'widgetPieChartRemarks', password: 'widgetPieChartPassword' });
  });

  it('a widget kind fails closed like every kind, and reads its own three keys', () => {
    const p = coerceReportDownloads({ widgetGaugeMode: 'DIRECT', widgetGaugeRemarks: false });
    expect(p['widget:gauge']).toEqual({ mode: 'DIRECT', remarksRequired: false, passwordRequired: true });
    expect(p['widget:pie_chart']).toEqual(REPORT_KIND_POLICY_DEFAULT);
  });
});

describe('widgetTypeTakesProfileFields — which types offer the profile key: / attr: fields', () => {
  it('every reportable type but the pie and the alarm counts; never a type with no catalogue', () => {
    const takes = WIDGET_TYPES.filter((t) => widgetTypeTakesProfileFields(t));
    expect(takes).toEqual(REPORTABLE_WIDGET_TYPES.filter((t) => t !== 'pie_chart' && t !== 'alarm_counts'));
    for (const t of ['pie_chart', 'alarm_counts', 'text_card', 'floorplan'] as const) {
      expect(widgetTypeTakesProfileFields(t)).toBe(false);
    }
    for (const t of ['gauge', 'latest_table', 'bar_chart', 'instrument_list'] as const) {
      expect(widgetTypeTakesProfileFields(t)).toBe(true);
    }
  });
});
