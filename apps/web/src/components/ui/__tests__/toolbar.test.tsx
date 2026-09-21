import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Toolbar } from '../toolbar';

/**
 * The search box needs a distinct `name` and an accessible label: an
 * unnamed text input beside a password field is what Chrome autofills the
 * username into (Alarms search box, 2026-08-31).
 */
describe('Toolbar', () => {
  it('renders a named, labelled search that reports typing, with filters and trailing actions', () => {
    const onChange = vi.fn();
    render(
      <Toolbar
        search={{ name: 'alarm-search', value: '', onChange, label: 'Search alarms', placeholder: 'Instrument, type, location' }}
        filters={<select aria-label="Type"><option>All</option></select>}
        trailing={<button type="button">Export</button>}
      />,
    );
    const box = screen.getByRole('textbox', { name: 'Search alarms' });
    expect(box).toHaveAttribute('name', 'alarm-search');
    fireEvent.change(box, { target: { value: 'CWH' } });
    expect(onChange).toHaveBeenCalledWith('CWH');
    expect(screen.getByRole('combobox', { name: 'Type' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });

  it('renders without a search box when none is given', () => {
    render(<Toolbar trailing={<button type="button">New</button>} />);
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
