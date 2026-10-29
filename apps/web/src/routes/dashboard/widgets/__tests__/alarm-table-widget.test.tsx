import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { CustomWidget } from '@digilog/shared';

const active = {
  id: 'a-1', instrumentCode: 'CWH/RDU/001-00', instrumentId: 'i-1', locationName: 'Raw Material Store',
  metric: 'TEMPERATURE', triggeredValue: 30, state: 'ACTIVE', raisedAt: '2026-08-10T00:00:00.000Z',
  clearedAt: null, acknowledgedAt: null, acknowledgedBy: null, acknowledgeReason: null,
  source: 'INSTRUMENT_LIMIT', limitKind: 'HIGH', clearedValue: null, ruleSnapshot: { limit: 25, decimals: 1 },
};
// Module-level constants: a fresh object per call hangs vitest.
const RESPONSE = { data: { data: [active], total: 7 }, error: undefined, mutate: () => Promise.resolve() };
const NOTHING = { data: undefined };
const requested: (string | null)[] = [];
vi.mock('swr', () => ({
  default: (key: string | null) => {
    requested.push(key);
    if (typeof key === 'string' && key.startsWith('/api/alarms')) return RESPONSE;
    return NOTHING;
  },
}));
vi.mock('@/hooks/use-can', () => ({ useCan: () => () => true }));
const TOAST = { toast: { success: vi.fn(), error: vi.fn() } };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => TOAST }));
vi.mock('@/lib/api-client', () => ({ apiClient: { postWithReauth: vi.fn() } }));
const FMT = { formatDate: (v: string) => v, formatTime: () => '', formatDateTime: (v: string) => v };
vi.mock('@/hooks/use-datetime-format', () => ({ useDatetimeFormat: () => FMT }));

import { AlarmTableWidget } from '../alarm-table-widget';

const W = (source: CustomWidget['source'], status?: 'active-unack'): CustomWidget => ({
  id: '3b1c2d3e-4f50-4617-8a9b-0c1d2e3f4a5b', type: 'alarm_table', title: 'Alarms', source, keys: [],
  options: status ? { status } : {},
});
const alarmKeys = () => requested.filter((x): x is string => typeof x === 'string' && x.startsWith('/api/alarms'));
const lastAlarmsQuery = () => new URLSearchParams(alarmKeys().at(-1)!.split('?')[1]);
const view = (w: CustomWidget, selection: Parameters<typeof AlarmTableWidget>[0]['selection']) =>
  render(<MemoryRouter><AlarmTableWidget widget={w} selection={selection} /></MemoryRouter>);

beforeEach(() => { requested.length = 0; });

describe('AlarmTableWidget', () => {
  it('an instruments-source widget requests instrumentIds=<a>,<b>', () => {
    view(W({ mode: 'instruments', ids: ['a', 'b'] }), { directOnly: false, profileId: 'ignored' });
    const q = lastAlarmsQuery();
    expect(q.get('instrumentIds')).toBe('a,b');
    expect(q.get('profileId')).toBeNull();
  });

  it('a selection with directOnly requests functionalLocationDirect=true', () => {
    view(W({ mode: 'selection' }), { functionalLocationId: 'fl-1', directOnly: true });
    const q = lastAlarmsQuery();
    expect(q.get('functionalLocationId')).toBe('fl-1');
    expect(q.get('functionalLocationDirect')).toBe('true');
  });

  it('a profile selection requests profileId', () => {
    view(W({ mode: 'selection' }), { directOnly: false, profileId: 'p-1' });
    expect(lastAlarmsQuery().get('profileId')).toBe('p-1');
  });

  it('the server rows and counts render', () => {
    view(W({ mode: 'selection' }), { directOnly: false });
    expect(screen.getByText('CWH/RDU/001-00')).toBeTruthy();
    expect(document.body.textContent).toMatch(/of\s*7/);
  });

  it('initialStatus is the starting filter', () => {
    view(W({ mode: 'selection' }, 'active-unack'), { directOnly: false });
    expect(lastAlarmsQuery().get('status')).toBe('active-unack');
  });

  it('an empty id list makes no request and prints No instruments in your view', () => {
    view(W({ mode: 'selection' }), { directOnly: false, instrumentIds: [] });
    expect(screen.getByText('No instruments in your view')).toBeTruthy();
    expect(alarmKeys()).toEqual([]);
  });
});
