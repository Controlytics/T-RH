import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LAYOUT_VERSION } from '@digilog/shared';

// Every dependency the page reaches is mocked with STABLE objects; the subject
// is only who gets the widget controls (operator 2026-10-28: "super admin only").
const AUTH: { user: { role: string } } = { user: { role: 'SUPER_ADMIN' } };
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => AUTH }));
const CAN = () => true;
vi.mock('@/hooks/use-can', () => ({ useCan: () => CAN }));
const PANELS = { showPanel: () => true, loaded: true };
vi.mock('@/hooks/use-panels', () => ({ usePanels: () => PANELS }));
const reset = vi.fn(async () => {});
const LAYOUT: Record<string, unknown> & { editing: boolean; widgets: unknown[] } = {
  items: [{ i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 }], widgets: [],
  editing: false, saving: false, loaded: true,
  start: () => {}, cancel: () => {}, save: async () => {}, reset, setDraft: () => {},
  setStyle: () => {}, setSize: () => {}, addWidget: () => {}, updateWidget: () => {}, removeWidget: () => {},
  saveAsRoleDefault: async () => {},
};
vi.mock('@/hooks/use-dashboard-layout', () => ({ useDashboardLayout: () => LAYOUT }));
const EMPTY = { data: undefined };
const TREE = { data: { data: [] } };
vi.mock('swr', () => ({ default: (key: string | null) => (key === '/api/functional-locations' ? TREE : EMPTY) }));
vi.mock('../telemetry-table', () => ({ TelemetryTable: () => null }));
vi.mock('../floorplan-view', () => ({ FloorplanView: () => null }));
vi.mock('../selection-alarms', () => ({ SelectionAlarms: () => null }));
vi.mock('../entry-cards', () => ({ EntryCards: () => null }));
vi.mock('../widgets/widget-dialog', () => ({ WidgetDialog: () => null }));
vi.mock('../widgets/role-default-dialog', () => ({ RoleDefaultDialog: () => null }));
// jsdom measures nothing; the grid draws nothing at width 0.
vi.mock('react-grid-layout', async (importActual) => ({
  ...(await importActual<typeof import('react-grid-layout')>()),
  useContainerWidth: () => ({ width: 1240, mounted: true, containerRef: { current: null } }),
}));
// Counts how many times a built widget's panel is MOUNTED (not rendered).
const panelMounts = vi.fn();
vi.mock('../widgets/widget-panel', async () => {
  const React = await import('react');
  return {
    WidgetPanel: ({ widget }: { widget: { title: string } }) => {
      React.useEffect(() => { panelMounts(widget.title); }, []);
      return React.createElement('div', { 'data-testid': 'built-widget' }, widget.title);
    },
  };
});
class StubResizeObserver { observe() {} disconnect() {} unobserve() {} }

import { DashboardPage } from '../index';

const renderPage = () => render(
  <MemoryRouter initialEntries={['/?fl=__all__']}>
    <DashboardPage />
  </MemoryRouter>,
);

describe('dashboard widget controls', () => {
  it('a SUPER_ADMIN arranging gets Add widget and Save as role default', () => {
    AUTH.user.role = 'SUPER_ADMIN';
    LAYOUT.editing = true;
    renderPage();
    expect(screen.getByRole('button', { name: 'Add widget' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Save as role default' })).toBeTruthy();
  });

  it('a SUPER_ADMIN not arranging sees Arrange only', () => {
    AUTH.user.role = 'SUPER_ADMIN';
    LAYOUT.editing = false;
    renderPage();
    expect(screen.getByRole('button', { name: 'Arrange' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull();
  });

  it('anyone else gets no Arrange and no widget controls', () => {
    AUTH.user.role = 'OPERATOR';
    LAYOUT.editing = false;
    renderPage();
    expect(screen.queryByRole('button', { name: 'Arrange' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as role default' })).toBeNull();
  });

  it('never offers widget controls to a non-super-admin, even mid-edit', () => {
    // Unreachable through the UI (Arrange is hidden), pinned anyway: the edit row
    // renders for whoever is editing, so the gate must be on the controls.
    AUTH.user.role = 'ADMIN';
    LAYOUT.editing = true;
    renderPage();
    expect(screen.queryByRole('button', { name: 'Add widget' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as role default' })).toBeNull();
  });
});

describe('Reset to default', () => {
  it('asks before deleting built widgets, and resets only on Confirm', async () => {
    // Review 2026-10-29 (Important): Reset deletes the caller's whole layout row,
    // widgets included — one click beside "Add widget" destroyed up to 20.
    AUTH.user.role = 'SUPER_ADMIN';
    LAYOUT.editing = true;
    LAYOUT.widgets = [{ id: 'w1' }, { id: 'w2' }];
    reset.mockClear();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(reset).not.toHaveBeenCalled();
    expect(screen.getByText(/2 built widgets/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reset and remove widgets' }));
    await waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    LAYOUT.widgets = [];
  });

  it('resets straight away when there are no built widgets to lose', () => {
    AUTH.user.role = 'SUPER_ADMIN';
    LAYOUT.editing = true;
    LAYOUT.widgets = [];
    reset.mockClear();
    renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Reset to default' }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('a built widget on the home dashboard', () => {
  const W = '11111111-1111-4111-8111-000000000001';
  const widget = (title: string, status?: string) => ({
    id: W, type: 'alarm_table', title, source: { mode: 'selection' }, keys: [], options: status ? { status } : {},
  });

  it('starts afresh when its definition is edited, so a changed default shows at once', () => {
    // WidgetPanel seeds its alarm status / page size / period from the widget
    // ONCE; without a key on the definition an edited widget kept the old ones
    // until a reload.
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
    AUTH.user.role = 'SUPER_ADMIN';
    LAYOUT.editing = false;
    LAYOUT.items = [{ i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 }, { i: `w:${W}`, x: 0, y: 9, w: 12, h: 5 }];
    LAYOUT.widgets = [widget('Open alarms')];
    panelMounts.mockClear();
    const view = renderPage();
    expect(screen.getByTestId('built-widget')).toHaveTextContent('Open alarms');
    expect(panelMounts).toHaveBeenCalledTimes(1);

    LAYOUT.widgets = [widget('Open alarms', 'ACTIVE')];
    view.rerender(<MemoryRouter initialEntries={['/?fl=__all__']}><DashboardPage /></MemoryRouter>);
    expect(panelMounts).toHaveBeenCalledTimes(2);

    // The same definition again is NOT a remount.
    LAYOUT.widgets = [widget('Open alarms', 'ACTIVE')];
    view.rerender(<MemoryRouter initialEntries={['/?fl=__all__']}><DashboardPage /></MemoryRouter>);
    expect(panelMounts).toHaveBeenCalledTimes(2);

    LAYOUT.items = [{ i: 'telemetry_table', x: 0, y: 0, w: 12, h: 9 }];
    LAYOUT.widgets = [];
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  });
});

void LAYOUT_VERSION;
