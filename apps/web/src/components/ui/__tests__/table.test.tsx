import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import {
  Table, TableHeader, TableGroupRow, TableHead, TableBody, TableRow, TableCell, TableEmpty, TableFooter,
} from '../table';

/**
 * The shared table, rebuilt for UI v3. Nineteen route files hand-rolled
 * their own <table> before this; what they needed and the primitive lacked
 * is pinned here: a grouped header row (screen-2.png's TEMPERATURE / HUMIDITY
 * bands), a sortable head that SAYS its sort (aria-sort, not an icon alone),
 * a row accent rail keyed on a status tone, an empty state inside the table's
 * own frame, and the pagination footer.
 */
describe('DataTable', () => {
  it('a sortable head carries aria-sort and reports a click', () => {
    const onSort = vi.fn();
    render(
      <Table>
        <TableHeader>
          <tr><TableHead sortable sortDir="desc" onSort={onSort}>Raised</TableHead></tr>
        </TableHeader>
      </Table>,
    );
    const head = screen.getByRole('columnheader', { name: /raised/i });
    expect(head).toHaveAttribute('aria-sort', 'descending');
    fireEvent.click(within(head).getByRole('button'));
    expect(onSort).toHaveBeenCalledTimes(1);
  });

  it('a group row spans its columns and names its hue', () => {
    render(
      <Table>
        <TableHeader>
          <TableGroupRow groups={[{ label: 'Instrument', span: 1 }, { label: 'Temperature (°C)', span: 2, hue: 'temp' }]} />
        </TableHeader>
      </Table>,
    );
    const temp = screen.getByRole('columnheader', { name: /temperature/i });
    expect(temp).toHaveAttribute('colspan', '2');
    expect(temp).toHaveAttribute('data-hue', 'temp');
  });

  it('a row accent is keyed on a status tone', () => {
    render(
      <Table><TableBody>
        <TableRow accent="danger"><TableCell>x</TableCell></TableRow>
      </TableBody></Table>,
    );
    expect(screen.getByRole('row')).toHaveAttribute('data-accent', 'danger');
  });

  it('the empty state sits inside the table frame and the footer pages', () => {
    const onPageChange = vi.fn();
    render(
      <Table>
        <TableBody><TableEmpty colSpan={3} title="No alarms" /></TableBody>
        <TableFooter colSpan={3} page={2} pageSize={25} totalItems={60} onPageChange={onPageChange} />
      </Table>,
    );
    expect(screen.getByText('No alarms')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /previous/i }));
    expect(onPageChange).toHaveBeenCalledWith(1);
  });
});

describe('every table is the Audit Trail table by default (2026-10-01)', () => {
  it('a plain <Table> carries the grid and the 15px size; a caller can still opt out', () => {
    const { container, rerender } = render(<Table><tbody><tr><td>x</td></tr></tbody></Table>);
    let t = container.querySelector('table')!;
    expect(t.className).toMatch(/(^|\s)tbl-grid(\s|$)/);
    expect(t.className).toContain('text-[0.9375rem]');
    expect(t.getAttribute('data-grid')).toBe('true');
    rerender(<Table grid={false} size="default"><tbody><tr><td>x</td></tr></tbody></Table>);
    t = container.querySelector('table')!;
    expect(t.className).not.toMatch(/(^|\s)tbl-grid(\s|$)/);
    expect(t.className).toContain('text-sm');
  });
});

