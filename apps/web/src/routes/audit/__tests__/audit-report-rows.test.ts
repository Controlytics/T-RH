import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  REPORT_TEMPLATE_FIELDS, builtinReportTemplate, getDefaultTemplates,
  type ReportTemplateDocument, type ReportTemplateRow,
} from '@digilog/shared';
import { resolveReportLabels } from '@/lib/report-labels';
import {
  AUDIT_BUILTIN_COLUMN_STYLES, AUDIT_DESCRIPTION_MAX, AUDIT_REPORT_COLUMNS,
  auditBuiltinDocument, auditExcelRows, auditPlaceholderValues, auditReportInput, rowsForAuditTrail,
} from '../audit-report-rows';
import { AUDIT_RECORDS } from './fixtures/audit-records';

/**
 * The Audit Trail's ROWS and its one SECTION on templates (2026-11-03, page
 * reports on templates — spec §6). A cell is the string the export printed
 * before templates; the Excel export keeps exactly its head and cells (it is
 * not templated — spec non-goal), built from the SAME rows so the two cannot
 * drift.
 */

const FROZEN = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'audit-report-builtin.json'), 'utf8')) as {
  excel: { head: string[]; rows: string[][] };
};
const fmt = { formatDateTime: (d: string) => d.slice(0, 16).replace('T', ' ') };
const templates = getDefaultTemplates();
const labels = resolveReportLabels('audit-trail', {});
const BUILTIN_IDS = REPORT_TEMPLATE_FIELDS('page:audit-trail').map((f) => f.id);

describe('the seven columns', () => {
  it('are the kind\'s built-in fields, in order, each tied to its report-labels key', () => {
    expect(AUDIT_REPORT_COLUMNS.map((c) => c.id)).toEqual(BUILTIN_IDS);
    expect(AUDIT_REPORT_COLUMNS.map((c) => labels.columns[c.labelKey])).toEqual(FROZEN.excel.head);
  });
});

describe('rowsForAuditTrail — today\'s strings, keyed by field id', () => {
  it('cell for cell what the export printed (the frozen Excel rows are those cells)', () => {
    const rows = rowsForAuditTrail(AUDIT_RECORDS, fmt, templates);
    expect(rows.map((r) => BUILTIN_IDS.map((id) => r[id]))).toEqual(FROZEN.excel.rows);
  });

  it('a redacted record announces itself first, and the description is cut AFTER the note', () => {
    const [, , redacted] = rowsForAuditTrail(AUDIT_RECORDS, fmt, templates);
    const text = String(redacted['audit.description']);
    expect(text.startsWith('[REDACTED by superadmin: Personal data removed on request]')).toBe(true);
    expect(text).toHaveLength(AUDIT_DESCRIPTION_MAX);
    expect(redacted['audit.ip']).toBe('-');
    expect(redacted['audit.role']).toBe('-');
  });
});

describe('the Excel export keeps its head and cells', () => {
  it('rows in column order from the same row builder', () => {
    expect(auditExcelRows(rowsForAuditTrail(AUDIT_RECORDS, fmt, templates))).toEqual(FROZEN.excel.rows);
  });
});

describe('auditPlaceholderValues', () => {
  it('no search = no value (the subtitle prints "Search: —", ruling P-2)', () => {
    expect(auditPlaceholderValues({ period: 'All Time', search: '', recordCount: 3 })).toEqual({ period: 'All Time', recordCount: '3' });
  });

  it('a search quoted as today\'s subtitle quoted it; the ends of the period when set', () => {
    expect(auditPlaceholderValues({ period: 'a to b', search: 'x', recordCount: 1, from: 'a', to: 'b' }))
      .toEqual({ period: 'a to b', search: '"x"', recordCount: '1', from: 'a', to: 'b' });
  });
});

describe('auditBuiltinDocument — the built-in reads report-labels', () => {
  it('with the shipped labels it IS the shared built-in', () => {
    expect(auditBuiltinDocument(labels)).toEqual(builtinReportTemplate('page:audit-trail'));
  });

  it('a label takes the title, the headings and — when set — the subtitle', () => {
    const doc = auditBuiltinDocument({ ...labels, title: 'Activity Log', subtitle: 'For {period}', columns: { ...labels.columns, ipAddress: 'Workstation' } });
    expect(doc.header.title).toBe('Activity Log');
    expect(doc.header.subtitle).toBe('For {period}');
    expect(doc.columns.find((c) => c.id === 'audit.ip')?.heading).toBe('Workstation');
  });
});

describe('auditReportInput — the ONE section the page prints', () => {
  const base = {
    records: AUDIT_RECORDS, fmt, templates, labels, period: 'All Time', search: '', printedAt: '2026-09-22T09:00:00.000Z', user: 'superadmin',
  };

  it('the built-in: today\'s widths, no legend, the date and the reader supplied', () => {
    const input = auditReportInput({ ...base, template: null });
    expect(input).toMatchObject({ kind: 'page:audit-trail', reportKey: 'audit-trail' });
    expect(input.legend).toBeUndefined();
    expect(input.formatDateTime).toBe(fmt.formatDateTime);
    expect(input.values).toMatchObject({ period: 'All Time', recordCount: '3', date: '2026-09-22 09:00', user: 'superadmin' });
    const [s] = input.sections;
    expect(s).toMatchObject({ profileId: null, profileName: null, availableIds: BUILTIN_IDS });
    expect(s.document).toEqual(auditBuiltinDocument(labels));
    expect(s.columnStyles).toEqual(AUDIT_BUILTIN_COLUMN_STYLES);
    expect(s.rows).toEqual(rowsForAuditTrail(AUDIT_RECORDS, fmt, templates));
  });

  it('a SAVED template: its own document and jsPDF\'s widths', () => {
    const document: ReportTemplateDocument = { ...builtinReportTemplate('page:audit-trail'), columns: [{ id: 'audit.action', heading: 'Did', show: true }] };
    const template = { id: 't1', name: 'Short', kind: 'page:audit-trail', profileId: null, isDefault: true, document } as unknown as ReportTemplateRow;
    const [s] = auditReportInput({ ...base, template }).sections;
    expect(s.document).toEqual(document);
    expect(s.columnStyles).toBeUndefined();
  });
});
