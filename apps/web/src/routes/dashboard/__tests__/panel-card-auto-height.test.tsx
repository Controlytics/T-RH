import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelCard } from '../panel-card';

/**
 * `PanelCard` measuring the height it wants (operator, 2026-09-01).
 *
 * The whole feature turns on ONE structural decision — **which element is
 * observed** — and getting it wrong fails silently in the exact shape of the
 * original complaint. The card and its scroll region both have their border box
 * pinned by the grid cell, so going from 25 rows to 50 grows `scrollHeight`
 * without changing either box, and ResizeObserver does not fire on a
 * `scrollHeight` change. Observe either of those and the panel resizes only when
 * the WINDOW does; a test that resizes the window passes either way.
 *
 * So these tests assert the observed element by identity, and drive a content
 * growth rather than a window resize.
 */

type Cb = () => void;
const observed: Element[] = [];
let fire: Cb = () => {};

class StubResizeObserver {
  constructor(cb: Cb) { fire = cb; }
  observe(el: Element) { observed.push(el); }
  disconnect() {}
  unobserve() {}
}

/** jsdom does no layout — every box is 0 — so the three numbers the card reads
 *  are stubbed directly. `scrollHeight` is the one that grows with the rows. */
function stubBox(el: HTMLElement, props: Partial<Record<'offsetHeight' | 'clientHeight' | 'scrollHeight', number>>) {
  for (const [k, v] of Object.entries(props)) {
    Object.defineProperty(el, k, { configurable: true, value: v });
  }
}

beforeEach(() => {
  observed.length = 0;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});
afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  vi.restoreAllMocks();
});

const renderCard = (props: Partial<React.ComponentProps<typeof PanelCard>> = {}) => render(
  <PanelCard
    title="Instrument Readings"
    eyebrow="Readings"
    editing={false}
    width={12}
    height={8}
    {...props}
  >
    <div data-testid="rows">25 rows</div>
  </PanelCard>,
);

describe('PanelCard — auto height', () => {
  it('observes the CONTENT wrapper, not the card or the scroll region', () => {
    // The assertion this file exists for. Both of the others are pinned by the
    // grid cell and would never fire on a page-size change.
    const { container } = renderCard({ autoHeight: true, onNaturalHeight: vi.fn() });
    const card = container.querySelector('.panel-card') as HTMLElement;
    const scroll = container.querySelector('.overflow-auto') as HTMLElement;

    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toBe(card);
    expect(observed[0]).not.toBe(scroll);
    // It is the element the children are actually rendered into.
    expect(observed[0].contains(screen.getByTestId('rows'))).toBe(true);
  });

  it('reports chrome + content, so nothing is clipped and nothing is spare', () => {
    const onNaturalHeight = vi.fn();
    const { container } = renderCard({ autoHeight: true, onNaturalHeight });
    const card = container.querySelector('.panel-card') as HTMLElement;
    const scroll = container.querySelector('.overflow-auto') as HTMLElement;

    // A 500px-tall card whose scroll region is 440px inside => 60px of chrome.
    stubBox(card, { offsetHeight: 500 });
    stubBox(scroll, { clientHeight: 440, scrollHeight: 700 });
    fire();

    expect(onNaturalHeight).toHaveBeenLastCalledWith(60 + 700);
  });

  it('reports a BIGGER height when the row count grows — the 25 to 50 case', () => {
    const onNaturalHeight = vi.fn();
    const { container } = renderCard({ autoHeight: true, onNaturalHeight });
    const card = container.querySelector('.panel-card') as HTMLElement;
    const scroll = container.querySelector('.overflow-auto') as HTMLElement;

    stubBox(card, { offsetHeight: 500 });
    stubBox(scroll, { clientHeight: 440, scrollHeight: 700 });
    fire();
    const at25 = onNaturalHeight.mock.calls.at(-1)![0];

    // The page size doubles. The card's own box does NOT change — the grid cell
    // still pins it — only the content inside it does. That is precisely why the
    // observed element has to be the one in natural flow.
    stubBox(scroll, { clientHeight: 440, scrollHeight: 1400 });
    fire();
    const at50 = onNaturalHeight.mock.calls.at(-1)![0];

    expect(at50).toBeGreaterThan(at25);
    expect(at50 - at25).toBe(700);
  });

  it('does not measure, or report, when it is not an auto-height card', () => {
    // The floorplan. Its height is the operator's to drag.
    const onNaturalHeight = vi.fn();
    renderCard({ autoHeight: false, onNaturalHeight });
    expect(observed).toHaveLength(0);
    expect(onNaturalHeight).not.toHaveBeenCalled();
  });

  it('survives an environment with no ResizeObserver, still reporting once', () => {
    // jsdom has none by default. One measurement must still happen, or a card in
    // such an environment never reports at all and keeps its stored height.
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const onNaturalHeight = vi.fn();
    expect(() => renderCard({ autoHeight: true, onNaturalHeight })).not.toThrow();
    expect(onNaturalHeight).toHaveBeenCalledTimes(1);
  });
});

describe('PanelCard — the height control', () => {
  const openEditor = (autoHeight: boolean) => {
    const r = render(
      <PanelCard
        title="Instrument Readings"
        eyebrow="Readings"
        editing
        width={12}
        height={8}
        autoHeight={autoHeight}
        onStyleChange={vi.fn()}
        onSizeChange={vi.fn()}
      >
        <div>rows</div>
      </PanelCard>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    return r;
  };

  it('is HIDDEN on an auto-height card, and says why', () => {
    // An inert control is a decoy: it would set an `h` the next measurement
    // overwrites within a frame, so it would appear to do nothing.
    openEditor(true);
    expect(screen.queryByText('Card height')).toBeNull();
    expect(screen.getByText(/Height follows the content/i)).toBeInTheDocument();
    // Width is still the operator's to choose.
    expect(screen.getByText('Card width')).toBeInTheDocument();
  });

  it('is SHOWN on a card that is still dragged — the floorplan', () => {
    openEditor(false);
    expect(screen.getByText('Card height')).toBeInTheDocument();
    expect(screen.queryByText(/Height follows the content/i)).toBeNull();
  });
});
