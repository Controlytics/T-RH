import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { StatCard } from '../stat-card';

/**
 * ONE number per card (operator rule, 2026-09-17: a secondary figure beside
 * a primary one reads as "showing two times"). The mockups' sparkline and
 * "from yesterday" are deliberately absent — nothing stores that history.
 */
const glyph = <svg data-testid="glyph" viewBox="0 0 24 24" />;

describe('StatCard', () => {
  it('prints the eyebrow and exactly one figure', () => {
    render(<MemoryRouter><StatCard eyebrow="Active unacknowledged" value={16} icon={glyph} tone="danger" /></MemoryRouter>);
    const card = screen.getByTestId('stat-card');
    expect(within(card).getByText('Active unacknowledged')).toBeInTheDocument();
    expect(within(card).getAllByText('16')).toHaveLength(1);
    expect(card).toHaveAttribute('data-tone', 'danger');
  });

  it('is neutral by default and links only when given a destination', () => {
    const { rerender } = render(<MemoryRouter><StatCard eyebrow="Total users" value={12} icon={glyph} /></MemoryRouter>);
    expect(screen.getByTestId('stat-card')).toHaveAttribute('data-tone', 'neutral');
    expect(screen.queryByRole('link')).toBeNull();
    rerender(<MemoryRouter><StatCard eyebrow="Total users" value={12} icon={glyph} to="/users" /></MemoryRouter>);
    expect(screen.getByRole('link', { name: /view details/i })).toHaveAttribute('href', '/users');
  });
});
