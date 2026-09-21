import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PageHero } from '../page-hero';

/**
 * The band every screen starts with. What matters is structure a test can
 * read: ONE h1, the crumbs, the tiles printing label and value once each, and
 * the caller's toolbar landing INSIDE the band — a toolbar rendered under it
 * is the two-row layout the operator asked to have joined on every widget.
 */
const mount = (extra: Partial<Parameters<typeof PageHero>[0]> = {}) => render(
  <MemoryRouter>
    <PageHero
      title="Alarms"
      crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Alarms' }]}
      tiles={[{ label: 'Active', value: 16 }, { label: 'Cleared', value: 8, hint: 'today' }]}
      {...extra}
    >
      <input aria-label="Search alarms" />
    </PageHero>
  </MemoryRouter>,
);

describe('PageHero', () => {
  it('renders one h1 and the breadcrumb trail', () => {
    mount();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toHaveTextContent('Dashboard');
  });

  it('prints each tile label and value exactly once', () => {
    mount();
    const band = screen.getByTestId('page-hero');
    expect(within(band).getAllByText('Active')).toHaveLength(1);
    expect(within(band).getAllByText('16')).toHaveLength(1);
    expect(within(band).getByText('today')).toBeInTheDocument();
  });

  it("puts the caller's toolbar INSIDE the band", () => {
    mount();
    const band = screen.getByTestId('page-hero');
    expect(band.contains(screen.getByRole('textbox', { name: 'Search alarms' }))).toBe(true);
  });

  it('renders no tile row and no toolbar row when neither is given', () => {
    render(<MemoryRouter><PageHero title="Users" /></MemoryRouter>);
    expect(screen.queryByTestId('page-hero-tiles')).toBeNull();
    expect(screen.queryByTestId('page-hero-toolbar')).toBeNull();
  });

  it('renders meta chips under the title, inside the band', () => {
    render(<MemoryRouter><PageHero title="CWH/RDU/001-00" meta={<span data-testid="chip">Active</span>} /></MemoryRouter>);
    expect(screen.getByTestId('page-hero').contains(screen.getByTestId('chip'))).toBe(true);
  });

  it("can carry a caller's test id and always says it is the v3 hero", () => {
    render(<MemoryRouter><PageHero title="Blocks" testId="fl-hero" /></MemoryRouter>);
    expect(screen.getByTestId('fl-hero')).toHaveAttribute('data-hero', 'v3');
    expect(screen.queryByTestId('page-hero')).toBeNull();
  });
});
