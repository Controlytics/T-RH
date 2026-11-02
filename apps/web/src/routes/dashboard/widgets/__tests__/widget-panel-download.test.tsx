import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { CustomWidget, LayoutItem } from '@digilog/shared';

/**
 * Every built widget's header carries Download report (2026-11-02, spec §8),
 * arranging or not, gated by Configuration → Export Options' "Dashboard
 * widgets" surface — fail-open like every surface, hidden only on an explicit
 * NONE (or Excel-only, which has no PDF).
 */

const FLAGS = { pdf: true, excel: true };
const surfaces: string[] = [];
vi.mock('@/hooks/use-export-options', () => ({
  useExportOptions: (surface: string) => { surfaces.push(surface); return FLAGS; },
}));
// The dialog has its own test; here only whether it is opened, for which widget.
const dialogProps: { open: boolean; widget: { id: string }; dashboardTitle: string; selectionLabel: string }[] = [];
vi.mock('../widget-report-dialog', () => ({
  WidgetReportDialog: (p: { open: boolean; widget: { id: string }; dashboardTitle: string; selectionLabel: string }) => {
    dialogProps.push(p);
    return p.open ? <div data-testid="widget-report-dialog">{p.widget.id}</div> : null;
  },
}));

import { WidgetPanel } from '../widget-panel';

const TEXT: CustomWidget = {
  id: 'w-text', type: 'text_card', title: 'Shift note', source: { mode: 'selection' }, keys: [], options: { text: 'Hello' },
} as CustomWidget;
const ITEM: LayoutItem = { i: 'custom:w-text', x: 0, y: 0, w: 6, h: 4 };

const renderPanel = (editing = false) => render(
  <WidgetPanel
    widget={TEXT}
    item={ITEM}
    selection={{ directOnly: false }}
    reportHost={{ dashboard: 'Dashboard', selection: 'All Instruments' }}
    editing={editing}
    onEdit={() => {}}
    onRemove={() => {}}
    onStyleChange={() => {}}
    onSizeChange={() => {}}
    autoHeight={false}
    onNaturalHeight={() => {}}
  />,
);

beforeEach(() => {
  FLAGS.pdf = true;
  surfaces.length = 0;
  dialogProps.length = 0;
});

describe('WidgetPanel — Download report', () => {
  it('shows the icon when the Dashboard widgets surface allows a PDF, asked of THAT surface', () => {
    renderPanel();
    expect(screen.getByRole('button', { name: 'Download report' })).toBeInTheDocument();
    expect(surfaces).toContain('dashboard-widgets');
  });

  it('hides it when the surface allows no PDF (NONE, or Excel only)', () => {
    FLAGS.pdf = false;
    renderPanel();
    expect(screen.queryByRole('button', { name: 'Download report' })).toBeNull();
  });

  it('shows it while arranging too — it is not an arranging control', () => {
    renderPanel(true);
    expect(screen.getByRole('button', { name: 'Download report' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit widget' })).toBeInTheDocument();
  });

  it("opens THIS widget's report dialog with the host's dashboard and selection", () => {
    renderPanel();
    expect(screen.queryByTestId('widget-report-dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Download report' }));
    expect(screen.getByTestId('widget-report-dialog')).toHaveTextContent('w-text');
    const last = dialogProps[dialogProps.length - 1];
    expect(last.dashboardTitle).toBe('Dashboard');
    expect(last.selectionLabel).toBe('All Instruments');
  });
});
