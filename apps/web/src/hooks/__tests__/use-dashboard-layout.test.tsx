import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { SWRConfig } from 'swr';
import { LAYOUT_VERSION, widgetItemId, type CustomWidget } from '@digilog/shared';

const get = vi.fn();
const put = vi.fn();
const putWithReauth = vi.fn();
const del = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    get: (...a: unknown[]) => get(...a),
    put: (...a: unknown[]) => put(...a),
    putWithReauth: (...a: unknown[]) => putWithReauth(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import { useDashboardLayout } from '../use-dashboard-layout';

const W1: CustomWidget = {
  id: '11111111-1111-4111-8111-111111111111', type: 'value_cards', title: 'Pressures',
  source: { mode: 'selection' }, keys: [{ source: 'telemetry', key: 'p' }], options: {},
};
const W2: CustomWidget = { ...W1, id: '22222222-2222-4222-8222-222222222222', type: 'trend_chart', title: 'Trend' };

const CONFIG = {
  layout: {
    version: LAYOUT_VERSION,
    items: [{ i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 }, { i: widgetItemId(W1.id), x: 0, y: 9, w: 6, h: 5 }],
    widgets: [W1],
  },
};

const wrapper = ({ children }: { children: ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0, fetcher: (u: string) => get(u) }}>{children}</SWRConfig>
);

async function loaded() {
  const hook = renderHook(() => useDashboardLayout(), { wrapper });
  await waitFor(() => expect(hook.result.current.loaded).toBe(true));
  return hook;
}

beforeEach(() => {
  get.mockReset().mockResolvedValue(CONFIG);
  put.mockReset().mockResolvedValue({ success: true });
  putWithReauth.mockReset().mockResolvedValue({ role: 'OPERATOR' });
  del.mockReset().mockResolvedValue({ success: true });
});

describe('useDashboardLayout and built widgets', () => {
  it('reads the server-resolved widgets', async () => {
    const { result } = await loaded();
    expect(result.current.widgets).toEqual([W1]);
  });

  it('add, edit and remove change the draft only, until Save', async () => {
    const { result } = await loaded();
    act(() => result.current.start());
    act(() => result.current.addWidget(W2));
    expect(result.current.widgets.map((w) => w.id)).toEqual([W1.id, W2.id]);
    const added = result.current.items.find((it) => it.i === widgetItemId(W2.id))!;
    expect(added).toMatchObject({ x: 0, w: 12, h: 9 });
    expect(added.y).toBeGreaterThanOrEqual(14); // below everything placed

    act(() => result.current.updateWidget({ ...W1, title: 'Renamed' }));
    expect(result.current.widgets[0].title).toBe('Renamed');

    act(() => result.current.removeWidget(W1.id));
    expect(result.current.widgets.map((w) => w.id)).toEqual([W2.id]);
    expect(result.current.items.some((it) => it.i === widgetItemId(W1.id))).toBe(false);
    expect(put).not.toHaveBeenCalled();
  });

  it('a value-cards widget starts short, the others medium', async () => {
    const { result } = await loaded();
    act(() => result.current.start());
    act(() => result.current.addWidget({ ...W1, id: '33333333-3333-4333-8333-333333333333' }));
    expect(result.current.items.find((it) => it.i === widgetItemId('33333333-3333-4333-8333-333333333333'))!.h).toBe(5);
  });

  it('Save sends the widgets with the items', async () => {
    const { result } = await loaded();
    act(() => result.current.start());
    act(() => result.current.addWidget(W2));
    await act(async () => { await result.current.save(); });
    expect(put).toHaveBeenCalledWith('/api/config/my-dashboard-layout', {
      layout: { version: LAYOUT_VERSION, items: expect.any(Array), widgets: [W1, W2] },
    });
    expect(put.mock.calls[0][1].layout.items.map((it: { i: string }) => it.i)).toContain(widgetItemId(W2.id));
  });

  it('Cancel discards an added widget', async () => {
    const { result } = await loaded();
    act(() => result.current.start());
    act(() => result.current.addWidget(W2));
    act(() => result.current.cancel());
    expect(result.current.widgets).toEqual([W1]);
    expect(put).not.toHaveBeenCalled();
  });

  it('Save as role default PUTs the arrangement on screen to that role, with the password when given', async () => {
    const { result } = await loaded();
    act(() => result.current.start());
    act(() => result.current.addWidget(W2));
    await act(async () => { await result.current.saveAsRoleDefault('OPERATOR', 'Secret1!'); });
    expect(putWithReauth).toHaveBeenCalledWith(
      '/api/roles/dashboard-layout/role/OPERATOR',
      { layout: { version: LAYOUT_VERSION, items: expect.any(Array), widgets: [W1, W2] } },
      'Secret1!',
    );
    await act(async () => { await result.current.saveAsRoleDefault('ADMIN'); });
    expect(put).toHaveBeenCalledWith('/api/roles/dashboard-layout/role/ADMIN', expect.objectContaining({ layout: expect.any(Object) }));
  });
});
