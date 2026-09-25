import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EntryCards } from '../entry-cards';
import { ALL_INSTRUMENTS, type NavCard } from '../location-nav';

/**
 * The landing was built to a supplied reference (`Screen-1.png`) showing exactly
 * four blocks. This installation's database has ONE, so the browser check could
 * only ever confirm a single card. These cover what the screenshot could not:
 * that the accent/glyph cycles hold for more blocks than the reference drew,
 * and that every figure on screen comes from props rather than the design.
 */

const card = (id: string, label: string, count: number, sublabel = 'Block'): NavCard =>
  ({ id, label, sublabel, count });

const FOUR: NavCard[] = [
  card(ALL_INSTRUMENTS, 'All Instruments', 107, 'Every registered instrument'),
  card('b1', 'CWH Block', 100),
  card('b2', 'FD Block', 0),
  card('b3', 'PFI Block', 0),
  card('b4', 'MUPS Block', 7),
];

const noop = () => {};

describe('EntryCards — the numbers are live', () => {
  it('shows the instrument total from props', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={{ active: 5, unacknowledged: 2 }} onOpenAlarms={noop} />);
    expect(screen.getByText('107')).toBeInTheDocument();
  });

  it('shows the alarm count from props', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={{ active: 5, unacknowledged: 2 }} onOpenAlarms={noop} />);
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders a card per block, with its own count', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    for (const name of ['CWH Block', 'FD Block', 'PFI Block', 'MUPS Block']) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText('7')).toBeInTheDocument();
    // Two blocks hold zero. Both must still render a card — a block that
    // disappears when it empties looks like a block that was deleted.
    expect(screen.getAllByText('0')).toHaveLength(2);
  });

  it('formats large counts with separators', () => {
    render(<EntryCards cards={[card(ALL_INSTRUMENTS, 'All Instruments', 12345)]} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    expect(screen.getByText('12,345')).toBeInTheDocument();
  });
});

describe('EntryCards — accents cycle past the reference’s four', () => {
  it('gives each of six blocks a distinct accent', () => {
    const six = [
      card(ALL_INSTRUMENTS, 'All Instruments', 0, ''),
      ...Array.from({ length: 6 }, (_, i) => card(`b${i}`, `Block ${i}`, i)),
    ];
    const { container } = render(<EntryCards cards={six} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    // Since 2026-09-25 the CARD is the colour: a gradient on the button itself.
    const blocks = container.querySelectorAll('button[data-accent]');
    const colours = new Set(Array.from(blocks).map((el) => el.getAttribute('style')));
    expect(blocks).toHaveLength(6);
    expect(colours.size).toBe(6);
  });

  // The cycle is what stops a seventh block rendering with no colour at all.
  it('wraps rather than running out on a seventh block', () => {
    const seven = [
      card(ALL_INSTRUMENTS, 'All Instruments', 0, ''),
      ...Array.from({ length: 7 }, (_, i) => card(`b${i}`, `Block ${i}`, i)),
    ];
    const { container } = render(<EntryCards cards={seven} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    const blocks = container.querySelectorAll('button[data-accent]');
    expect(blocks).toHaveLength(7);
    for (const c of blocks) expect(c.getAttribute('style')).toMatch(/linear-gradient/);
    // The seventh wears the first accent again, not a blank.
    expect(blocks[6].getAttribute('data-accent')).toBe('0');
    expect(blocks[6].getAttribute('style')).toBe(blocks[0].getAttribute('style'));
  });
});

describe('EntryCards — behaviour', () => {
  it('selects the block that was clicked', () => {
    const onSelect = vi.fn();
    render(<EntryCards cards={FOUR} onSelect={onSelect} alarms={null} onOpenAlarms={noop} />);
    fireEvent.click(screen.getByRole('button', { name: /PFI Block/ }));
    expect(onSelect).toHaveBeenCalledWith('b3');
  });

  it('navigates to alarms rather than filtering', () => {
    const onOpenAlarms = vi.fn();
    const onSelect = vi.fn();
    render(<EntryCards cards={FOUR} onSelect={onSelect} alarms={{ active: 5, unacknowledged: 0 }} onOpenAlarms={onOpenAlarms} />);
    fireEvent.click(screen.getByRole('button', { name: /Active alarms/i }));
    expect(onOpenAlarms).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  // The card is hidden for a viewer without the permission, not shown empty.
  it('omits the alarms card when alarms are null', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    expect(screen.queryByText('Active Alarms')).toBeNull();
  });

  it('drops the Blocks Overview section when there are no blocks', () => {
    render(<EntryCards cards={[card(ALL_INSTRUMENTS, 'All Instruments', 3, '')]} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    expect(screen.queryByText('Blocks Overview')).toBeNull();
  });

  // A red zero teaches people to ignore red. Green at zero, red when it matters.
  // Since 2026-09-25 the whole CARD carries the tone (the figure is white on
  // both), so assert the card's tone and that its ground actually changes.
  it('reads green at zero alarms and red above it', () => {
    const onlyAll = [card(ALL_INSTRUMENTS, 'All Instruments', 42, '')];
    const { rerender } = render(
      <EntryCards cards={onlyAll} onSelect={noop} alarms={{ active: 0, unacknowledged: 0 }} onOpenAlarms={noop} />,
    );
    const atZero = screen.getByRole('button', { name: /Active alarms/i });
    expect(atZero).toHaveAttribute('data-tone', 'ok');
    const groundAtZero = atZero.getAttribute('style');
    expect(groundAtZero).toMatch(/linear-gradient/);

    rerender(<EntryCards cards={onlyAll} onSelect={noop} alarms={{ active: 3, unacknowledged: 0 }} onOpenAlarms={noop} />);
    const above = screen.getByRole('button', { name: /Active alarms/i });
    expect(above).toHaveAttribute('data-tone', 'danger');
    expect(above.getAttribute('style')).toMatch(/linear-gradient/);
    expect(above.getAttribute('style')).not.toBe(groundAtZero);
  });

  it('says there is nothing to attend to at zero', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={{ active: 0, unacknowledged: 0 }} onOpenAlarms={noop} />);
    expect(screen.getByText('Nothing to attend to')).toBeInTheDocument();
  });
});

describe('EntryCards — accessibility', () => {
  it('every card is a real button with a full label', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={{ active: 5, unacknowledged: 1 }} onOpenAlarms={noop} />);
    // 1 All Instruments + 1 Alarms + 4 blocks
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(6);
    for (const b of buttons) {
      expect(b.getAttribute('aria-label')).toBeTruthy();
      expect(b).toHaveAttribute('type', 'button');
    }
  });

  // The count is split from the label visually; the accessible name has to carry
  // both or a screen-reader user hears "CWH Block" and no number.
  it('puts the count in the accessible name', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    expect(screen.getByRole('button', { name: /MUPS Block — 7 instruments/ })).toBeInTheDocument();
  });

  it('marks decorative artwork aria-hidden', () => {
    const { container } = render(<EntryCards cards={FOUR} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    const svgs = Array.from(container.querySelectorAll('svg'));
    expect(svgs.length).toBeGreaterThan(0);
    for (const s of svgs) expect(s.getAttribute('aria-hidden')).toBe('true');
  });

  // Operator, 2026-09-25: "remove symbols in cards". The only SVGs left are the
  // block waves — no glyph discs, no corner icons, no link arrow.
  it('prints no symbols: every SVG is a wave', () => {
    const { container } = render(<EntryCards cards={FOUR} onSelect={noop} alarms={{ active: 2, unacknowledged: 0 }} onOpenAlarms={noop} />);
    const svgs = container.querySelectorAll('svg');
    const waves = container.querySelectorAll('svg.pointer-events-none');
    expect(svgs.length).toBe(waves.length);
    expect(waves.length).toBe(4);
  });

  // A <button> centres its content vertically; in a shared grid row the shorter
  // hero card's heading floated mid-card (operator, 2026-09-25: "why gap coming
  // on active alarms heading top"). Every card is a column flex box so content
  // stacks from the top, and the footer is pushed down with mt-auto.
  it('stacks card content from the top and pins View Details to the bottom', () => {
    render(<EntryCards cards={FOUR} onSelect={noop} alarms={{ active: 2, unacknowledged: 0 }} onOpenAlarms={noop} />);
    for (const b of screen.getAllByRole('button')) {
      expect(b.className).toMatch(/(^|\s)flex(\s|$)/);
      expect(b.className).toMatch(/(^|\s)flex-col(\s|$)/);
      const footer = Array.from(b.querySelectorAll('div')).find((d) => d.textContent?.includes('View Details') && d.className.includes('mt-auto'));
      expect(footer).toBeTruthy();
    }
  });

  it('does not let the decorative wave intercept clicks', () => {
    const { container } = render(<EntryCards cards={FOUR} onSelect={noop} alarms={null} onOpenAlarms={noop} />);
    const waves = container.querySelectorAll('svg.pointer-events-none');
    expect(waves.length).toBe(4);
  });
});
