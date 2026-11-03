import { describe, it, expect } from 'vitest';
import { WIDGET_TYPES, WIDGET_TYPE_SPECS } from '../dashboard-widgets.js';
import {
  PAGE_TEMPLATE_KINDS, TEMPLATE_KINDS, TEMPLATE_KIND_SPECS, PAGE_REPORT_FIELDS, REPORT_PLACEHOLDERS,
  WIDGET_REPORT_FIELDS, REPORT_TEMPLATE_FIELDS, isTemplateKind, isPageTemplateKind, templateKindOf,
  templateKindTakesProfileFields, templateKindScope, templateKindLabel, widgetTypeTakesProfileFields,
  builtinReportTemplate, coerceReportTemplateDocument, keyRowsCollapse, reportTemplateCreateSchema,
  reportTemplateDocumentSchema, substitutePlaceholders,
} from '../report-templates.js';
import { REPORT_KINDS, type ReportKind } from '../report-downloads.js';

/**
 * Page reports on templates (spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §4, §6;
 * plan Task 1). The vocabulary widens from "widget type" to "template kind": the
 * fourteen widget types plus five page-report kinds, each with ONE spec (scope,
 * profile fields, built-in fields, placeholders, orientation, typography) and a
 * built-in document that reproduces today's page PDF.
 */

describe('template kinds', () => {
  it('are the fourteen widget types, then the five page kinds — nineteen, no duplicates', () => {
    expect([...PAGE_TEMPLATE_KINDS]).toEqual(['page:data-report', 'page:trend', 'page:instrument-alarms', 'page:alarms', 'page:audit-trail']);
    expect(TEMPLATE_KINDS).toHaveLength(19);
    expect(new Set(TEMPLATE_KINDS).size).toBe(19);
    expect([...TEMPLATE_KINDS]).toEqual([...WIDGET_TYPES, ...PAGE_TEMPLATE_KINDS]);
  });

  it('isTemplateKind / isPageTemplateKind name exactly the vocabulary', () => {
    expect(isTemplateKind('page:alarms')).toBe(true);
    expect(isTemplateKind('gauge')).toBe(true);
    expect(isTemplateKind('page:nope')).toBe(false);
    expect(isTemplateKind('widget:gauge')).toBe(false);
    expect(isTemplateKind(undefined)).toBe(false);
    expect(isPageTemplateKind('page:audit-trail')).toBe(true);
    expect(isPageTemplateKind('gauge')).toBe(false);
    expect(isPageTemplateKind('page:nope')).toBe(false);
    expect(isPageTemplateKind(7)).toBe(false);
  });
});

describe('templateKindOf — which template a download kind is drawn from (spec §4)', () => {
  it('maps the eight page download kinds onto the five page template kinds', () => {
    expect(templateKindOf('data-report')).toBe('page:data-report');
    expect(templateKindOf('time-series')).toBe('page:data-report');
    expect(templateKindOf('trend-header')).toBe('page:data-report');
    expect(templateKindOf('temperature-trend')).toBe('page:trend');
    expect(templateKindOf('humidity-trend')).toBe('page:trend');
    expect(templateKindOf('instrument-alarms')).toBe('page:instrument-alarms');
    expect(templateKindOf('alarms')).toBe('page:alarms');
    expect(templateKindOf('audit-trail')).toBe('page:audit-trail');
  });

  it('maps every widget:<type> onto its widget type', () => {
    for (const t of WIDGET_TYPES) expect(templateKindOf(`widget:${t}`), t).toBe(t);
  });

  it('every one of the 22 download kinds maps onto a template kind', () => {
    expect(REPORT_KINDS).toHaveLength(22);
    for (const { key } of REPORT_KINDS) expect(isTemplateKind(templateKindOf(key)), key).toBe(true);
  });

  it('refuses a string that is not a download kind rather than answering undefined', () => {
    expect(() => templateKindOf('nope' as ReportKind)).toThrow();
    expect(() => templateKindOf('widget:nope' as ReportKind)).toThrow();
  });
});

describe('TEMPLATE_KIND_SPECS — the ONE description of each kind', () => {
  it('has an entry for every kind and none other', () => {
    expect(Object.keys(TEMPLATE_KIND_SPECS).sort()).toEqual([...TEMPLATE_KINDS].sort());
  });

  it('every widget type: profile scope, its own fields, its own label, profile fields as widgetTypeTakesProfileFields says', () => {
    for (const t of WIDGET_TYPES) {
      const s = TEMPLATE_KIND_SPECS[t];
      expect(s.scope, t).toBe('profile');
      expect(s.fields, t).toEqual(WIDGET_REPORT_FIELDS[t]);
      expect(s.profileFields, t).toBe(widgetTypeTakesProfileFields(t) ? 'all' : 'none');
      expect(templateKindTakesProfileFields(t), t).toBe(s.profileFields);
      expect(s.label, t).toBe(WIDGET_TYPE_SPECS[t].label);
      expect(templateKindLabel(t), t).toBe(WIDGET_TYPE_SPECS[t].label);
      expect(s.typography, t).toBe('default');
      expect(s.landscape, t).toBe(builtinReportTemplate(t).page.orientation === 'landscape');
      // The widget kinds keep their ten placeholders, and only those.
      expect([...s.placeholders].sort(), t).toEqual(['dashboard', 'date', 'from', 'instrumentCount', 'period', 'profile', 'selection', 'to', 'user', 'widget']);
    }
  });

  it('the two application kinds have no profile and no profile fields; the other three page kinds take attributes', () => {
    for (const k of ['page:alarms', 'page:audit-trail'] as const) {
      expect(TEMPLATE_KIND_SPECS[k].scope, k).toBe('application');
      expect(templateKindScope(k), k).toBe('application');
      expect(TEMPLATE_KIND_SPECS[k].profileFields, k).toBe('none');
    }
    for (const k of ['page:data-report', 'page:trend', 'page:instrument-alarms'] as const) {
      expect(TEMPLATE_KIND_SPECS[k].scope, k).toBe('profile');
      expect(templateKindScope(k), k).toBe('profile');
      expect(TEMPLATE_KIND_SPECS[k].profileFields, k).toBe('attributes');
      expect(templateKindTakesProfileFields(k), k).toBe('attributes');
    }
    expect(templateKindScope('gauge')).toBe('profile');
  });

  it('the Audit Trail is landscape, the Data Report has its own typography, the rest are portrait and default', () => {
    expect(TEMPLATE_KIND_SPECS['page:audit-trail'].landscape).toBe(true);
    expect(TEMPLATE_KIND_SPECS['page:data-report'].typography).toBe('data-report');
    for (const k of ['page:data-report', 'page:trend', 'page:instrument-alarms', 'page:alarms'] as const) {
      expect(TEMPLATE_KIND_SPECS[k].landscape, k).toBe(false);
    }
    for (const k of ['page:trend', 'page:instrument-alarms', 'page:alarms', 'page:audit-trail'] as const) {
      expect(TEMPLATE_KIND_SPECS[k].typography, k).toBe('default');
    }
  });

  it('names each page kind as the page does', () => {
    expect(PAGE_TEMPLATE_KINDS.map((k) => templateKindLabel(k))).toEqual(['Data Report', 'Instrument Trend', 'Instrument Alarms', 'Alarm Report', 'Audit Trail']);
  });
});

describe('PAGE_REPORT_FIELDS — each page kind\'s built-in fields (spec §6)', () => {
  const ids = (k: keyof typeof PAGE_REPORT_FIELDS) => PAGE_REPORT_FIELDS[k].map((f) => f.id);
  const labels = (k: keyof typeof PAGE_REPORT_FIELDS) => PAGE_REPORT_FIELDS[k].map((f) => f.label);

  it('Data Report: the four columns, headed as the page heads them', () => {
    expect(ids('page:data-report')).toEqual(['record.date', 'record.time', 'record.temperature', 'record.humidity']);
    expect(labels('page:data-report')).toEqual(['DATE', 'TIME', 'TEMPERATURE (°C)', 'RELATIVE HUMIDITY(%)']);
    expect(PAGE_REPORT_FIELDS['page:data-report'].filter((f) => f.kind === 'number').map((f) => f.id)).toEqual(['record.temperature', 'record.humidity']);
  });

  it('Instrument Alarms: the six columns, sharing the alarm table\'s ids where the meaning is the same', () => {
    expect(ids('page:instrument-alarms')).toEqual(['alarm.type', 'alarm.raisedAt', 'alarm.value', 'alarm.limit', 'alarm.clearedAt', 'alarm.status']);
    expect(labels('page:instrument-alarms')).toEqual(['Type', 'Raised', 'Value', 'Limit', 'Cleared', 'Status']);
    const alarmTable = new Set(WIDGET_REPORT_FIELDS.alarm_table.map((f) => f.id));
    for (const id of ids('page:instrument-alarms')) expect(alarmTable.has(id), id).toBe(true);
  });

  it('Alarm Report: the ten columns, the placement columns FIRST — today\'s `reportHead` is EXTRA_COLUMNS then ALARM_REPORT_HEAD (ruling T1-F)', () => {
    expect(ids('page:alarms')).toEqual(['instrument.code', 'instrument.area', 'instrument.location', 'alarm.date', 'alarm.time', 'alarm.description', 'alarm.uom', 'alarm.pv', 'alarm.high', 'alarm.low']);
    expect(labels('page:alarms')).toEqual(['INSTRUMENT ID', 'AREA', 'LOCATION', 'DATE', 'TIME', 'DESCRIPTION', 'UOM', 'PV VALUE', 'HIGH LIMIT', 'LOW LIMIT']);
  });

  it('Audit Trail: the seven columns, headed as report-labels\' defaults', () => {
    expect(ids('page:audit-trail')).toEqual(['audit.timestamp', 'audit.action', 'audit.user', 'audit.role', 'audit.targetType', 'audit.description', 'audit.ip']);
    expect(labels('page:audit-trail')).toEqual(['Timestamp', 'Action', 'User', 'Role', 'Target Type', 'Description', 'IP Address']);
  });

  it('Instrument Trend has no fields — it prints its chart(s) with the chrome', () => {
    expect(PAGE_REPORT_FIELDS['page:trend']).toEqual([]);
  });

  it('every page field is a built-in with a namespaced id, unique per kind, and never per key', () => {
    for (const k of PAGE_TEMPLATE_KINDS) {
      const fieldIds = PAGE_REPORT_FIELDS[k].map((f) => f.id);
      expect(new Set(fieldIds).size, k).toBe(fieldIds.length);
      for (const f of PAGE_REPORT_FIELDS[k]) {
        expect(f.group, `${k} ${f.id}`).toBe('builtin');
        expect(f.id, k).toMatch(/^[a-z]+\.[A-Za-z]+$/);
        expect(f.perKey, `${k} ${f.id}`).toBeUndefined();
      }
    }
  });

  it('REPORT_TEMPLATE_FIELDS reads the widget fields for a widget type and the page fields for a page kind', () => {
    for (const t of WIDGET_TYPES) expect(REPORT_TEMPLATE_FIELDS(t), t).toBe(WIDGET_REPORT_FIELDS[t]);
    for (const k of PAGE_TEMPLATE_KINDS) expect(REPORT_TEMPLATE_FIELDS(k), k).toBe(PAGE_REPORT_FIELDS[k]);
    for (const k of TEMPLATE_KINDS) expect(TEMPLATE_KIND_SPECS[k].fields, k).toEqual(REPORT_TEMPLATE_FIELDS(k));
  });
});

describe('placeholders', () => {
  it('the vocabulary is the ten it had, then the seventeen page names, appended in order', () => {
    expect([...REPORT_PLACEHOLDERS]).toEqual([
      'dashboard', 'widget', 'profile', 'from', 'to', 'period', 'date', 'user', 'instrumentCount', 'selection',
      'instrument', 'block', 'area', 'location', 'fromDate', 'fromTime', 'toDate', 'toTime', 'interval', 'mkt',
      'tempLimit', 'rhLimit', 'extremes', 'recordCount', 'search', 'series', 'level',
    ]);
  });

  it('each kind supplies only names of the vocabulary', () => {
    const vocabulary = new Set<string>(REPORT_PLACEHOLDERS);
    for (const k of TEMPLATE_KINDS) {
      for (const p of TEMPLATE_KIND_SPECS[k].placeholders) expect(vocabulary.has(p), `${k} ${p}`).toBe(true);
      expect(new Set(TEMPLATE_KIND_SPECS[k].placeholders).size, k).toBe(TEMPLATE_KIND_SPECS[k].placeholders.length);
    }
  });

  it('the Data Report supplies its parameter block\'s names; the Audit Trail its own and no instrument', () => {
    expect(TEMPLATE_KIND_SPECS['page:data-report'].placeholders).toEqual(expect.arrayContaining([
      'block', 'area', 'location', 'instrument', 'fromDate', 'fromTime', 'toDate', 'toTime', 'tempLimit', 'rhLimit',
      'extremes', 'interval', 'mkt', 'from', 'to', 'period', 'date', 'user', 'profile',
    ]));
    const audit = TEMPLATE_KIND_SPECS['page:audit-trail'].placeholders;
    expect(audit).toEqual(expect.arrayContaining(['period', 'search', 'recordCount', 'date', 'user', 'from', 'to']));
    expect(audit).not.toContain('instrument');
    expect(audit).not.toContain('profile');
    expect(TEMPLATE_KIND_SPECS['page:alarms'].placeholders).not.toContain('profile');
    expect(TEMPLATE_KIND_SPECS['page:trend'].placeholders).toContain('series');
    expect(TEMPLATE_KIND_SPECS['page:alarms'].placeholders).toContain('level');
  });

  it('the new names resolve', () => {
    expect(substitutePlaceholders('{block}/{search}', { block: 'B1', search: 'x' })).toBe('B1/x');
  });

  it('every built-in names only what its own kind supplies — in its title, its subtitle and its information rows', () => {
    for (const k of TEMPLATE_KINDS) {
      const b = builtinReportTemplate(k);
      const supplied = new Set<string>(TEMPLATE_KIND_SPECS[k].placeholders);
      const tokens = `${b.header.title} ${b.header.subtitle ?? ''}`.match(/\{([A-Za-z][A-Za-z0-9]*)\}/g) ?? [];
      for (const t of tokens) expect(supplied.has(t.slice(1, -1)), `${k} ${t}`).toBe(true);
      for (const r of b.infoBlock) expect(supplied.has(r.source), `${k} ${r.source}`).toBe(true);
    }
  });
});

describe('builtinReportTemplate — a page kind\'s built-in IS today\'s layout (spec §6)', () => {
  const INSTRUMENT_HEADER = ['block', 'fromDate', 'area', 'fromTime', 'location', 'toDate', 'instrument', 'toTime'];
  const INSTRUMENT_HEADER_LABELS = ['Block', 'Start Date', 'Area', 'Start Time', 'Location', 'End Date', 'Inst ID', 'End Time'];
  const allShown = (k: keyof typeof PAGE_REPORT_FIELDS) => PAGE_REPORT_FIELDS[k].map((f) => ({ id: f.id, heading: f.label, show: true }));

  it('every kind\'s built-in passes the document schema', () => {
    for (const k of TEMPLATE_KINDS) {
      const r = reportTemplateDocumentSchema.safeParse(builtinReportTemplate(k));
      expect(r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), k).toEqual([]);
    }
  });

  it('Data Report: its title, no app name, its typography, portrait, the thirteen parameter rows in order, four columns, NO legend (ruling P-1)', () => {
    const b = builtinReportTemplate('page:data-report');
    expect(b.header.title).toBe('Temperature and RH Data Report');
    expect(b.header.subtitle).toBeUndefined();
    expect(b.header.showAppName).toBe(false);
    expect(b.header.logo).toEqual({ mode: 'branding' });
    expect(b.page).toEqual({ orientation: 'portrait', typography: 'data-report' });
    expect(b.infoBlock.map((r) => r.source)).toEqual(['block', 'fromDate', 'area', 'fromTime', 'location', 'toDate', 'instrument', 'toTime', 'tempLimit', 'rhLimit', 'extremes', 'interval', 'mkt']);
    expect(b.infoBlock.map((r) => r.label)).toEqual(['Block', 'Start Date', 'Area', 'Start Time', 'Location', 'End Date', 'Inst ID', 'End Time', 'Temp. Limit', 'RH Limit', 'Extremes', 'Interval', 'MKT']);
    expect(b.columns).toEqual(allShown('page:data-report'));
    // The page passes today's STRUCTURED legend; a saved template's own text replaces it.
    expect(b.notes.legend).toBeUndefined();
    expect(b.footer).toEqual({ showPageNumbers: true, showPrintedBy: true, showPrintedAt: true, signatureLine: false });
  });

  it('Instrument Trend: the series in the title, today\'s sentence as the subtitle, the eight header rows, no columns', () => {
    const b = builtinReportTemplate('page:trend');
    expect(b.header.title).toBe('Instrument Trend — {series}');
    expect(b.header.subtitle).toBe('{instrument} — {series}. The chart as seen on screen. The Instrument Time Series report covers the same readings unaveraged.');
    expect(b.header.showAppName).toBe(true);
    expect(b.page).toEqual({ orientation: 'portrait', typography: 'default' });
    expect(b.infoBlock.map((r) => r.source)).toEqual(INSTRUMENT_HEADER);
    expect(b.infoBlock.map((r) => r.label)).toEqual(INSTRUMENT_HEADER_LABELS);
    expect(b.columns).toEqual([]);
    expect(b.notes).toEqual({});
  });

  it('Instrument Alarms: its title, the instrument as the subtitle, the eight header rows, six columns', () => {
    const b = builtinReportTemplate('page:instrument-alarms');
    expect(b.header.title).toBe('Instrument Alarms');
    expect(b.header.subtitle).toBe('{instrument}');
    expect(b.header.showAppName).toBe(true);
    expect(b.page).toEqual({ orientation: 'portrait', typography: 'default' });
    expect(b.infoBlock.map((r) => r.source)).toEqual(INSTRUMENT_HEADER);
    expect(b.infoBlock.map((r) => r.label)).toEqual(INSTRUMENT_HEADER_LABELS);
    expect(b.columns).toEqual(allShown('page:instrument-alarms'));
  });

  it('Alarm Report: ALARM REPORT, the app name, portrait, the four period rows, ten columns shown, NO legend (ruling P-1)', () => {
    const b = builtinReportTemplate('page:alarms');
    expect(b.header.title).toBe('ALARM REPORT');
    expect(b.header.subtitle).toBeUndefined();
    expect(b.header.showAppName).toBe(true);
    expect(b.page).toEqual({ orientation: 'portrait', typography: 'default' });
    expect(b.infoBlock.map((r) => r.source)).toEqual(['fromDate', 'fromTime', 'toDate', 'toTime']);
    expect(b.infoBlock.map((r) => r.label)).toEqual(['Start Date', 'Start Time', 'End Date', 'End Time']);
    expect(b.columns).toEqual(allShown('page:alarms'));
    expect(b.columns.map((c) => c.heading)).toEqual(['INSTRUMENT ID', 'AREA', 'LOCATION', 'DATE', 'TIME', 'DESCRIPTION', 'UOM', 'PV VALUE', 'HIGH LIMIT', 'LOW LIMIT']);
    expect(b.columns.filter((c) => c.show)).toHaveLength(10);
    expect(b.notes.legend).toBeUndefined();
  });

  it('Audit Trail: landscape, no information rows, the exact subtitle of ruling P-2, seven columns', () => {
    const b = builtinReportTemplate('page:audit-trail');
    expect(b.header.title).toBe('Audit Trail');
    expect(b.header.subtitle).toBe('Period: {period}  |  Search: {search}  |  Total: {recordCount} record(s)  |  21 CFR Part 11 Compliant');
    expect(b.page).toEqual({ orientation: 'landscape', typography: 'default' });
    expect(b.infoBlock).toEqual([]);
    expect(b.columns).toEqual(allShown('page:audit-trail'));
    // P-2: no search prints "—" (substitutePlaceholders is unchanged); a search prints as the page quotes it.
    expect(substitutePlaceholders(b.header.subtitle!, { period: 'All Time', recordCount: '3' }))
      .toBe('Period: All Time  |  Search: —  |  Total: 3 record(s)  |  21 CFR Part 11 Compliant');
    expect(substitutePlaceholders(b.header.subtitle!, { period: 'All Time', search: '"x"', recordCount: '3' }))
      .toBe('Period: All Time  |  Search: "x"  |  Total: 3 record(s)  |  21 CFR Part 11 Compliant');
  });

  it('returns a FRESH document each call for a page kind too', () => {
    const a = builtinReportTemplate('page:trend');
    a.infoBlock[0].label = 'Changed';
    a.infoBlock.push({ label: 'X', source: 'date' });
    const c = builtinReportTemplate('page:alarms');
    c.columns[0].heading = 'Changed';
    expect(builtinReportTemplate('page:trend').infoBlock[0].label).toBe('Block');
    expect(builtinReportTemplate('page:trend').infoBlock).toHaveLength(8);
    expect(builtinReportTemplate('page:instrument-alarms').infoBlock[0].label).toBe('Block');
    expect(builtinReportTemplate('page:alarms').columns[0].heading).toBe('INSTRUMENT ID');
  });
});

describe('the reader, the row grain and the create body for a page kind', () => {
  it('keyRowsCollapse is false for every page kind, whatever the document shows', () => {
    expect(keyRowsCollapse('page:data-report', builtinReportTemplate('page:data-report'))).toBe(false);
    for (const k of PAGE_TEMPLATE_KINDS) {
      const d = builtinReportTemplate(k);
      d.columns = d.columns.map((c) => ({ ...c, show: false }));
      expect(keyRowsCollapse(k, d), k).toBe(false);
    }
  });

  it('coerceReportTemplateDocument reads anything unreadable as the page kind\'s built-in', () => {
    expect(coerceReportTemplateDocument({}, 'page:alarms')).toEqual(builtinReportTemplate('page:alarms'));
    expect(coerceReportTemplateDocument(null, 'page:audit-trail')).toEqual(builtinReportTemplate('page:audit-trail'));
  });

  it('create: a page kind with no profile id; an unknown kind refused; the old widgetType key no longer names a kind', () => {
    const document = builtinReportTemplate('page:alarms');
    expect(reportTemplateCreateSchema.safeParse({ kind: 'page:alarms', name: 'A', document }).success).toBe(true);
    expect(reportTemplateCreateSchema.safeParse({ kind: 'nope', name: 'A', document }).success).toBe(false);
    expect(reportTemplateCreateSchema.safeParse({ widgetType: 'gauge', name: 'A', document: builtinReportTemplate('gauge') }).success).toBe(false);
  });

  it('create: every kind may be made', () => {
    for (const k of TEMPLATE_KINDS) {
      const r = reportTemplateCreateSchema.safeParse({ kind: k, name: k, document: builtinReportTemplate(k) });
      expect(r.success, k).toBe(true);
    }
  });
});
