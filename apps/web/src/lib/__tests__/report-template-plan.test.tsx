import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { REPORT_TEMPLATE_FIELDS, builtinReportTemplate, type ReportTemplateRow, type TemplateKind } from '@digilog/shared';

const get = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: { get: (...a: unknown[]) => get(...a) } }));

import {
  BUILTIN_TEMPLATE_PICK, chooseTemplate, reportTemplatesCatalogueUrl, reportTemplatesListUrl, reportTemplatesResolveUrl,
  useReportTemplatePlan,
} from '../report-template-plan';

/**
 * The ONE plan every download dialog shows and prints from (2026-11-03): the
 * server's resolution per scope, asked by KIND. A profile kind resolves its
 * instruments in runs of 200 and asks each profile's templates and catalogue;
 * an application kind asks ONE resolve with no ids and its templates with no
 * profile. Pinned on the requests themselves — the wire is the contract with
 * the API (Task 2).
 */

const row = (id: string, kind: TemplateKind, profileId: string | null, isDefault = false): ReportTemplateRow => ({
  id, kind, profileId, name: id, isDefault, document: builtinReportTemplate(kind),
  createdAt: '2026-11-03T00:00:00.000Z', updatedAt: '2026-11-03T00:00:00.000Z', updatedBy: 'admin',
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);
const urls = () => get.mock.calls.map((c) => String(c[0]));
const params = (url: string) => new URL(url, 'https://x').searchParams;

beforeEach(() => { get.mockReset(); });

describe('useReportTemplatePlan — a PROFILE kind', () => {
  it('resolves in runs of 200 by kind, merges a profile across runs, then asks its templates and catalogue — never widgetType', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `i${i}`);
    const DEFAULT = row('t1', 'page:data-report', 'p1', true);
    get.mockImplementation(async (url: string) => {
      const u = new URL(url, 'https://x');
      if (u.pathname === '/api/report-templates/resolve') {
        const asked = u.searchParams.get('instrumentIds')!.split(',');
        return { sections: [{ profileId: 'p1', profileName: 'T&RH', instrumentIds: asked.slice(0, 2), template: DEFAULT }] };
      }
      if (u.pathname === '/api/report-templates/catalogue') return { fields: [{ id: 'record.date' }, { id: 'attr:Building' }] };
      if (u.pathname === '/api/report-templates') return { data: [DEFAULT, row('t2', 'page:data-report', 'p1')] };
      throw new Error(`unexpected ${url}`);
    });
    const { result } = renderHook(() => useReportTemplatePlan('page:data-report', ids), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    const resolves = urls().filter((u) => u.startsWith('/api/report-templates/resolve'));
    expect(resolves.map((u) => params(u).get('instrumentIds')!.split(',').length)).toEqual([200, 50]);
    for (const u of urls()) {
      expect(params(u).get('kind')).toBe('page:data-report');
      expect(u).not.toContain('widgetType');
    }
    expect(urls()).toContain(reportTemplatesListUrl('page:data-report', 'p1'));
    expect(urls()).toContain(reportTemplatesCatalogueUrl('page:data-report', 'p1'));
    expect(result.current.sections).toEqual([{
      profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i0', 'i1', 'i200', 'i201'],
      resolved: DEFAULT, templates: [DEFAULT, row('t2', 'page:data-report', 'p1')], availableIds: ['record.date', 'attr:Building'],
    }]);
    expect(result.current.error).toBeUndefined();
  });

  it('no instruments → no request, no section, not loading', async () => {
    const { result } = renderHook(() => useReportTemplatePlan('gauge', []), { wrapper });
    expect(result.current).toEqual({ sections: [], loading: false, error: undefined });
    expect(get).not.toHaveBeenCalled();
  });

  it('enabled: false asks nothing', () => {
    renderHook(() => useReportTemplatePlan('gauge', ['i1'], { enabled: false }), { wrapper });
    expect(get).not.toHaveBeenCalled();
  });

  it('the catalogue is asked when the kind can name a field: page:trend (no fields, attr: info rows) yes; a text card no', async () => {
    get.mockImplementation(async (url: string) => {
      const u = new URL(url, 'https://x');
      if (u.pathname === '/api/report-templates/resolve') return { sections: [{ profileId: 'p1', profileName: 'T&RH', instrumentIds: ['i1'], template: null }] };
      if (u.pathname === '/api/report-templates/catalogue') return { fields: [{ id: 'attr:Building' }] };
      return { data: [] };
    });
    const trend = renderHook(() => useReportTemplatePlan('page:trend', ['i1']), { wrapper });
    await waitFor(() => expect(trend.result.current.loading).toBe(false));
    expect(urls().some((u) => u.startsWith('/api/report-templates/catalogue'))).toBe(true);
    expect(trend.result.current.sections[0].availableIds).toEqual(['attr:Building']);

    get.mockClear();
    const text = renderHook(() => useReportTemplatePlan('text_card', ['i1']), { wrapper });
    await waitFor(() => expect(text.result.current.loading).toBe(false));
    expect(urls().some((u) => u.startsWith('/api/report-templates/catalogue'))).toBe(false);
    expect(text.result.current.sections[0].availableIds).toEqual([]);
  });
});

describe('useReportTemplatePlan — an APPLICATION kind', () => {
  it('ONE resolve with no ids, the templates with no profile, no catalogue; the built-ins are what it can fill', async () => {
    const AUDIT = row('a1', 'page:audit-trail', null, true);
    get.mockImplementation(async (url: string) => {
      const u = new URL(url, 'https://x');
      if (u.pathname === '/api/report-templates/resolve') return { sections: [{ profileId: null, profileName: null, instrumentIds: [], template: AUDIT }] };
      if (u.pathname === '/api/report-templates') return { data: [AUDIT] };
      throw new Error(`unexpected ${url}`);
    });
    // Ids handed to an application kind are ignored: the server would refuse them.
    const { result } = renderHook(() => useReportTemplatePlan('page:audit-trail', ['i1']), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(urls().sort()).toEqual([
      '/api/report-templates/resolve?kind=page%3Aaudit-trail',
      '/api/report-templates?kind=page%3Aaudit-trail',
    ].sort());
    expect(reportTemplatesResolveUrl('page:audit-trail')).toBe('/api/report-templates/resolve?kind=page%3Aaudit-trail');
    expect(result.current.sections).toEqual([{
      profileId: null, profileName: null, instrumentIds: [], resolved: AUDIT, templates: [AUDIT],
      availableIds: REPORT_TEMPLATE_FIELDS('page:audit-trail').map((f) => f.id),
    }]);
  });

  it('it is asked even with no instruments at all', async () => {
    get.mockImplementation(async (url: string) => (url.startsWith('/api/report-templates/resolve')
      ? { sections: [{ profileId: null, profileName: null, instrumentIds: [], template: null }] }
      : { data: [] }));
    const { result } = renderHook(() => useReportTemplatePlan('page:alarms', []), { wrapper });
    await waitFor(() => expect(result.current.sections).toHaveLength(1));
    expect(result.current.sections[0].resolved).toBeNull();
  });

  it('a failed resolve is the plan\'s error, and it stops loading', async () => {
    get.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useReportTemplatePlan('page:alarms', []), { wrapper });
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error));
    expect(result.current.loading).toBe(false);
  });
});

describe('chooseTemplate', () => {
  const resolved = row('t1', 'gauge', 'p1', true);
  const other = row('t2', 'gauge', 'p1');
  const section = { resolved, templates: [resolved, other] };
  it('the pick wins; the built-in pick is null; no pick (or a stale one) is the server\'s resolution', () => {
    expect(chooseTemplate(section, 't2')).toBe(other);
    expect(chooseTemplate(section, BUILTIN_TEMPLATE_PICK)).toBeNull();
    expect(chooseTemplate(section, undefined)).toBe(resolved);
    expect(chooseTemplate(section, 'gone')).toBe(resolved);
    expect(chooseTemplate({ resolved: null, templates: [] }, undefined)).toBeNull();
  });
});
