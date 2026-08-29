import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Tabs, TabPanel, type TabDef } from '../tabs';

/**
 * These tests exist because of `9a9bb9e`, which backed out `role="tablist"`
 * from the role-access bar on the grounds that the role advertises a keyboard
 * contract the bar did not implement. The primitive is only allowed to claim
 * that role if the contract is real, so every clause of it is asserted here:
 * roving tabindex, arrow keys with wrap, Home/End, and aria-controls naming a
 * panel that actually exists.
 */

const TABS: TabDef<'a' | 'b' | 'c'>[] = [
  { id: 'a', label: 'Alpha' },
  { id: 'b', label: 'Bravo' },
  { id: 'c', label: 'Charlie' },
];

function Harness({ initial = 'a', tabs = TABS }: { initial?: 'a' | 'b' | 'c'; tabs?: TabDef<'a' | 'b' | 'c'>[] }) {
  const [active, setActive] = useState<'a' | 'b' | 'c'>(initial);
  return (
    <>
      <Tabs tabs={tabs} active={active} onChange={setActive} idPrefix="t" aria-label="Test tabs" />
      <TabPanel id={active} idPrefix="t">panel {active}</TabPanel>
    </>
  );
}

describe('Tabs — structure', () => {
  it('exposes a labelled tablist', () => {
    render(<Harness />);
    expect(screen.getByRole('tablist', { name: 'Test tabs' })).toBeInTheDocument();
  });

  it('renders one tab per definition', () => {
    render(<Harness />);
    expect(screen.getAllByRole('tab')).toHaveLength(3);
  });

  it('marks exactly one tab selected', () => {
    render(<Harness />);
    const selected = screen.getAllByRole('tab').filter((t) => t.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveTextContent('Alpha');
  });

  // The clause that made the previous attempt dishonest: aria-controls must
  // name a panel that is really in the tree.
  it('aria-controls points at a panel that exists', () => {
    render(<Harness />);
    const tab = screen.getByRole('tab', { name: 'Alpha' });
    const panelId = tab.getAttribute('aria-controls')!;
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId)).not.toBeNull();
    expect(document.getElementById(panelId)).toHaveAttribute('role', 'tabpanel');
  });

  it('the panel points back at its tab', () => {
    render(<Harness />);
    const panel = screen.getByRole('tabpanel');
    const labelledBy = panel.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)).toHaveTextContent('Alpha');
  });
});

describe('Tabs — roving tabindex', () => {
  // Without this, Tab walks through every tab in the bar instead of moving
  // into and out of it — the thing the ARIA role promises.
  it('puts only the active tab in the page tab order', () => {
    render(<Harness />);
    const [a, b, c] = screen.getAllByRole('tab');
    expect(a).toHaveAttribute('tabindex', '0');
    expect(b).toHaveAttribute('tabindex', '-1');
    expect(c).toHaveAttribute('tabindex', '-1');
  });

  it('moves the tab stop when the selection changes', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('tab', { name: 'Bravo' }));
    const [a, b] = screen.getAllByRole('tab');
    expect(a).toHaveAttribute('tabindex', '-1');
    expect(b).toHaveAttribute('tabindex', '0');
  });
});

describe('Tabs — keyboard', () => {
  it('ArrowRight selects and focuses the next tab', () => {
    render(<Harness />);
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    const bravo = screen.getByRole('tab', { name: 'Bravo' });
    expect(bravo).toHaveAttribute('aria-selected', 'true');
    expect(bravo).toHaveFocus();
  });

  it('ArrowLeft moves backwards', () => {
    render(<Harness initial="b" />);
    screen.getByRole('tab', { name: 'Bravo' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  // Wraps on purpose — a tablist is a circular list, and stopping at the ends
  // makes a seven-tab bar feel broken.
  it('ArrowLeft from the first tab wraps to the last', () => {
    render(<Harness />);
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowLeft' });
    expect(screen.getByRole('tab', { name: 'Charlie' })).toHaveAttribute('aria-selected', 'true');
  });

  it('ArrowRight from the last tab wraps to the first', () => {
    render(<Harness initial="c" />);
    screen.getByRole('tab', { name: 'Charlie' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  it('Home jumps to the first tab', () => {
    render(<Harness initial="c" />);
    screen.getByRole('tab', { name: 'Charlie' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'Home' });
    expect(screen.getByRole('tab', { name: 'Alpha' })).toHaveAttribute('aria-selected', 'true');
  });

  it('End jumps to the last tab', () => {
    render(<Harness />);
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'End' });
    expect(screen.getByRole('tab', { name: 'Charlie' })).toHaveAttribute('aria-selected', 'true');
  });

  it('skips a disabled tab when arrowing', () => {
    const withDisabled: TabDef<'a' | 'b' | 'c'>[] = [
      { id: 'a', label: 'Alpha' },
      { id: 'b', label: 'Bravo', disabled: true },
      { id: 'c', label: 'Charlie' },
    ];
    render(<Harness tabs={withDisabled} />);
    screen.getByRole('tab', { name: 'Alpha' }).focus();
    fireEvent.keyDown(screen.getByRole('tablist'), { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: 'Charlie' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Tabs — selection', () => {
  it('reports the clicked tab', () => {
    const onChange = vi.fn();
    render(<Tabs tabs={TABS} active="a" onChange={onChange} idPrefix="t" />);
    fireEvent.click(screen.getByRole('tab', { name: 'Charlie' }));
    expect(onChange).toHaveBeenCalledWith('c');
  });

  it('does not report a disabled tab', () => {
    const onChange = vi.fn();
    render(
      <Tabs
        tabs={[{ id: 'a', label: 'Alpha' }, { id: 'b', label: 'Bravo', disabled: true }]}
        active="a"
        onChange={onChange}
        idPrefix="t"
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Bravo' }));
    expect(onChange).not.toHaveBeenCalled();
  });

  // Buttons inside a form default to type="submit"; a tab that submits its
  // surrounding form would be a nasty surprise on the config pages.
  it('renders buttons that do not submit a form', () => {
    render(<Harness />);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab).toHaveAttribute('type', 'button');
    }
  });
});
