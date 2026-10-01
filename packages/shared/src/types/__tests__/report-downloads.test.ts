import { describe, it, expect } from 'vitest';
import {
  coerceReportDownloads, coerceReportDownloadsResponse, reportDownloadsRow, reportTypeMatchesKind, reportKindSettingKeys, isReportKind, REPORT_KINDS,
  REPORT_DOWNLOADS_CONFIG_KEY, REPORT_KIND_POLICY_DEFAULT,
} from '../report-downloads.js';

/**
 * Per report type: Direct / Request, remarks required, password required
 * (Configuration → Report Downloads, 2026-10-01). `coerceReportDownloads` is the
 * ONE reader; every switch fails CLOSED on its own.
 */
describe('coerceReportDownloads', () => {
  it('reads an absent or malformed row as today\'s behaviour for every kind: REQUEST, remarks and password required', () => {
    for (const v of [undefined, null, 'x', [], {}]) {
      const p = coerceReportDownloads(v);
      for (const { key } of REPORT_KINDS) expect(p[key]).toEqual(REPORT_KIND_POLICY_DEFAULT);
    }
    expect(REPORT_KIND_POLICY_DEFAULT).toEqual({ mode: 'REQUEST', remarksRequired: true, passwordRequired: true });
  });

  it('reads each kind from its own three keys, independently', () => {
    const p = coerceReportDownloads({
      alarmsMode: 'DIRECT', alarmsRemarks: false, alarmsPassword: false,
      auditTrailMode: 'DIRECT', auditTrailRemarks: true,
      dataReportMode: 'REQUEST', dataReportPassword: false,
      timeSeriesMode: 'DIRECT', timeSeriesRemarks: true, timeSeriesPassword: true,
    });
    expect(p.alarms).toEqual({ mode: 'DIRECT', remarksRequired: false, passwordRequired: false });
    expect(p['audit-trail']).toEqual({ mode: 'DIRECT', remarksRequired: true, passwordRequired: true });
    expect(p['data-report']).toEqual({ mode: 'REQUEST', remarksRequired: true, passwordRequired: false });
    expect(p['temperature-trend']).toEqual(REPORT_KIND_POLICY_DEFAULT);
    // A split type's OWN keys win over the setting it came from.
    expect(p['time-series']).toEqual({ mode: 'DIRECT', remarksRequired: true, passwordRequired: true });
  });

  it('a type SPLIT OUT of another reads that one\'s values while its own are absent ("copy values ok")', () => {
    const p = coerceReportDownloads({
      dataReportMode: 'DIRECT', dataReportRemarks: false, dataReportPassword: true,
      trendChartMode: 'DIRECT', trendChartRemarks: true, trendChartPassword: false,
    });
    expect(p['time-series']).toEqual({ mode: 'DIRECT', remarksRequired: false, passwordRequired: true });
    expect(p['trend-header']).toEqual({ mode: 'DIRECT', remarksRequired: false, passwordRequired: true });
    expect(p['temperature-trend']).toEqual({ mode: 'DIRECT', remarksRequired: true, passwordRequired: false });
    expect(p['humidity-trend']).toEqual({ mode: 'DIRECT', remarksRequired: true, passwordRequired: false });
    // A type that was not split inherits nothing.
    expect(p.alarms).toEqual(REPORT_KIND_POLICY_DEFAULT);
  });

  it('reportDownloadsRow writes every type\'s OWN keys and round-trips through the reader', () => {
    const p = coerceReportDownloads({ trendChartMode: 'DIRECT', alarmsRemarks: false });
    const row = reportDownloadsRow(p);
    expect(row).not.toHaveProperty('trendChartMode');
    expect(row.temperatureTrendMode).toBe('DIRECT');
    expect(coerceReportDownloads(row)).toEqual(p);
  });

  it('fails closed on anything but the exact values that turn a control off', () => {
    const p = coerceReportDownloads({ alarmsMode: 'direct', alarmsRemarks: 'false', alarmsPassword: 0 });
    expect(p.alarms).toEqual(REPORT_KIND_POLICY_DEFAULT);
  });

  it('names eight kinds, each with unique setting keys, under one config key', () => {
    expect(REPORT_DOWNLOADS_CONFIG_KEY).toBe('report-downloads');
    expect(REPORT_KINDS.map((k) => k.key)).toEqual(['data-report', 'time-series', 'trend-header', 'temperature-trend', 'humidity-trend', 'instrument-alarms', 'alarms', 'audit-trail']);
    const all = REPORT_KINDS.flatMap((k) => Object.values(reportKindSettingKeys(k.key)));
    expect(new Set(all).size).toBe(all.length);
    expect(isReportKind('alarms')).toBe(true);
    expect(isReportKind('Alarms')).toBe(false);
    expect(isReportKind(undefined)).toBe(false);
  });
});

describe("coerceReportDownloadsResponse — the narrow route's per-kind shape", () => {
  it('reads what the route returns, kind by kind', () => {
    const p = coerceReportDownloadsResponse({ alarms: { mode: 'DIRECT', remarksRequired: false, passwordRequired: false } });
    expect(p.alarms).toEqual({ mode: 'DIRECT', remarksRequired: false, passwordRequired: false });
    expect(p['audit-trail']).toEqual(REPORT_KIND_POLICY_DEFAULT);
  });

  it('is NOT the stored-row reader: the flat row read here is all defaults, and vice versa', () => {
    expect(coerceReportDownloadsResponse({ alarmsMode: 'DIRECT' }).alarms.mode).toBe('REQUEST');
    expect(coerceReportDownloads({ alarms: { mode: 'DIRECT' } }).alarms.mode).toBe('REQUEST');
  });
});

describe('reportTypeMatchesKind', () => {
  it('binds each kind to the audit reportType it produces, so a kind cannot be borrowed', () => {
    expect(reportTypeMatchesKind('temperature-trend', 'Instrument Trend — Temperature')).toBe(true);
    expect(reportTypeMatchesKind('temperature-trend', 'Instrument Trend — Humidity')).toBe(false);
    expect(reportTypeMatchesKind('trend-header', 'Instrument Time Series')).toBe(true);
    expect(reportTypeMatchesKind('audit-trail', 'Instrument Time Series')).toBe(false);
  });
});
