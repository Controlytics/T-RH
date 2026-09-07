import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The Data Report page (2026-09-07). Operator: *"in dashboard Instruments
 * history widget was there that widget removed there and add one side bar
 * option Data Report, in that it should come"*.
 *
 * The page is a header plus the Instrument History widget, so what is worth
 * pinning is the WIRING: the screen is named once, by the page header, and
 * the widget — which used to print its own title on the Instruments page and
 * defer to the PanelCard's on the dashboard — prints none of its own here. Two
 * headings for one screen is the shape the dashboard's `embedded` flag existed
 * to prevent, and that flag went with the panel.
 *
 * NOT VERIFIED HERE: what it looks like. Read out of the DOM, not seen.
 */

const tree = [{ id: 'b1', name: 'CWH Block', children: [{ id: 'a1', name: 'QC 3' }] }];

function dataFor(key: string | null): any {
  if (!key) return undefined;
  if (key.includes('/api/functional-locations')) return { data: tree };
  if (key.includes('/telemetry-overview')) return { data: [] };
  if (key.startsWith('/api/instruments?')) return { data: [], total: 0 };
  return {};
}

vi.mock('swr', () => ({
  default: (key: any) => ({ data: dataFor(typeof key === 'function' ? key() : key), isLoading: false, error: undefined }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async (url: string) => dataFor(url)), post: vi.fn(async () => ({})), postWithReauth: vi.fn(async () => ({})) },
}));

const { DataReportPage } = await import('../index');

describe('DataReportPage', () => {
  it('names the screen once, in the page header, and mounts the history widget under it', () => {
    render(
      <MemoryRouter initialEntries={['/data-report']}>
        <DataReportPage />
      </MemoryRouter>,
    );
    expect(screen.getByRole('heading', { name: 'Data Report' })).toBeInTheDocument();
    expect(screen.getByTestId('history-widget')).toBeInTheDocument();
    // The widget's Block / Area / interval controls are there.
    expect(screen.getByLabelText('Block')).toBeInTheDocument();
    expect(screen.getByLabelText('History interval')).toBeInTheDocument();
    // The Generate Data Report card (operator, 2026-09-07: "one card only text
    // should be there Generate Data report and one download icon") sits ABOVE
    // the widget, and it is the page's ONE download trigger.
    const card = screen.getByTestId('generate-report-card');
    expect(card).toHaveTextContent('Generate Data report');
    expect(screen.getAllByRole('button', { name: 'Export as PDF' })).toHaveLength(1);
    expect(card.compareDocumentPosition(screen.getByTestId('history-widget')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // And it does NOT print a second title of its own.
    expect(screen.queryByRole('heading', { name: 'Instrument History' })).toBeNull();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });
});
