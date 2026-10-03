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
      tiles={[{ label: 'Active', value: 16, testId: 'tile-active' }, { label: 'Cleared', value: 8, hint: 'today' }]}
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
    expect(screen.getByTestId('tile-active')).toHaveTextContent('16');
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

  /**
   * 2026-10-03, operator: "instrument selection dropdown was not showing
   * values properly in dropdown". The band carried `overflow-hidden` on its
   * ROOT to clip its two decorative circles, and that clipped every popup a
   * caller's toolbar opens inside it — the Settings picker's list and the
   * Export menu on the Alarms and Audit heroes — to the band's bottom
   * padding. The clip now sits on the decoration alone. Read as class
   * tokens: jsdom has no layout, so this is the rule, not the picture; the
   * picture was checked in headless Chrome with the built stylesheet.
   */
  it('does NOT clip its content — only the decoration is overflow-hidden, so a popup opened in the toolbar can hang below the band', () => {
    mount();
    const band = screen.getByTestId('page-hero');
    expect(band.className).not.toMatch(/(^|\s)overflow-hidden(\s|$)/);
    const decoration = screen.getByTestId('page-hero-decoration');
    expect(decoration.className).toMatch(/(^|\s)overflow-hidden(\s|$)/);
    expect(decoration).toHaveAttribute('aria-hidden', 'true');
    // The toolbar is not inside the clipped decoration.
    expect(decoration.contains(screen.getByRole('textbox', { name: 'Search alarms' }))).toBe(false);
  });

  /**
   * Same report, second cause, seen only once the first was fixed: the
   * toolbar wrapper's `backdrop-blur-sm` is a `backdrop-filter`, which forms
   * a STACKING CONTEXT — so a popup's `z-50` inside it ranked only among the
   * toolbar's own children, and the next card on the page (a positioned
   * sibling of the band) painted over the list's options. No blur on the
   * toolbar, and the toolbar sits above the band's siblings explicitly.
   */
  it('gives the toolbar no backdrop filter and lifts it above the band\'s siblings, so a popup inside it is not painted over', () => {
    mount();
    const toolbar = screen.getByTestId('page-hero-toolbar');
    expect(toolbar.className).not.toMatch(/(^|\s)backdrop-blur(-\w+)?(\s|$)/);
    expect(toolbar.className).toMatch(/(^|\s)relative(\s|$)/);
    expect(toolbar.className).toMatch(/(^|\s)z-10(\s|$)/);
  });
});
