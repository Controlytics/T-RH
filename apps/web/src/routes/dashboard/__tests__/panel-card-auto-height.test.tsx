import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PanelCard, usePanelToolbarSlot } from '../panel-card';
import { createPortal } from 'react-dom';

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

/**
 * jsdom does no layout, so the boxes the card reads are stubbed — but FAITHFULLY.
 *
 * The constraint that matters, and the one an independent `scrollHeight` stub
 * hides: **`scrollHeight` can never be less than `clientHeight`.** A container
 * taller than its content reports its OWN height, not the content's. Stubbing the
 * two independently lets a test describe a DOM that cannot exist — which is how
 * the 50 -> 25 shrink bug passed a green suite on 2026-09-01.
 *
 * @param panelPx  the height the GRID CELL currently gives the card — pinned, so
 *                 it does not follow the content
 * @param chrome   header + borders, i.e. everything outside the scroll region
 * @param contentPx the content's own natural height
 */
function stubLayout(
  container: HTMLElement,
  { panelPx, chrome, contentPx, padY = 0 }:
  { panelPx: number; chrome: number; contentPx: number; padY?: number },
) {
  const card = container.querySelector('.panel-card') as HTMLElement;
  const scroll = container.querySelector('.overflow-auto') as HTMLElement;
  const content = scroll.firstElementChild as HTMLElement;
  const clientHeight = panelPx - chrome;

  // The panel's padding is operator-configurable and the card reads it back off
  // the element, so the test sets it rather than assuming it away. `clientHeight`
  // includes it; the reported height must too, or every panel comes out two
  // paddings short and clips its last row.
  scroll.style.padding = `${padY / 2}px`;

  Object.defineProperty(card, 'offsetHeight', { configurable: true, value: panelPx });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: clientHeight });
  Object.defineProperty(scroll, 'scrollHeight', {
    configurable: true,
    get: () => Math.max(contentPx + padY, clientHeight),
  });
  content.getBoundingClientRect = () => ({ height: contentPx, width: 0, top: 0, left: 0,
    right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
  return { card, scroll, content };
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
    // A 500px card with 60px of chrome, holding 700px of content: overflowing.
    stubLayout(container, { panelPx: 500, chrome: 60, contentPx: 700 });
    fire();
    expect(onNaturalHeight).toHaveBeenLastCalledWith(60 + 700);
  });

  it('reports a BIGGER height when the row count grows — the 25 to 50 case', () => {
    const onNaturalHeight = vi.fn();
    const { container } = renderCard({ autoHeight: true, onNaturalHeight });

    stubLayout(container, { panelPx: 500, chrome: 60, contentPx: 700 });
    fire();
    const at25 = onNaturalHeight.mock.calls.at(-1)![0];

    // The page size doubles. The card's own box does NOT change — the grid cell
    // still pins it — only the content inside it does.
    stubLayout(container, { panelPx: 500, chrome: 60, contentPx: 1400 });
    fire();
    const at50 = onNaturalHeight.mock.calls.at(-1)![0];

    expect(at50).toBeGreaterThan(at25);
    expect(at50 - at25).toBe(700);
  });

  it('reports a SMALLER height when the row count drops — the 50 to 25 case', () => {
    /**
     * THE regression this file was missing (operator, 2026-09-01: *"first 50 and
     * then i changed to 25 then automatically widget height was not adjusting,
     * there was more empty space remaining in down"*).
     *
     * The card is ALREADY TALL — the grid cell still gives it the 50-row height —
     * and the content has shrunk well inside it. The measurement must fall.
     *
     * It did not, and the reason is the one `stubLayout` now models: the card read
     * `scroll.scrollHeight`, which is `max(content, clientHeight)` and therefore
     * cannot report less than the container's own height. Growing worked, because
     * overflow pushes scrollHeight above clientHeight; shrinking could never work
     * at all. The old stub set the two independently and so described a DOM that
     * cannot exist.
     */
    const onNaturalHeight = vi.fn();
    const { container } = renderCard({ autoHeight: true, onNaturalHeight });

    stubLayout(container, { panelPx: 1500, chrome: 60, contentPx: 1400 });
    fire();
    const at50 = onNaturalHeight.mock.calls.at(-1)![0];

    // Same pinned panel, a quarter of the content.
    stubLayout(container, { panelPx: 1500, chrome: 60, contentPx: 400 });
    fire();
    const at25 = onNaturalHeight.mock.calls.at(-1)![0];

    expect(at25).toBeLessThan(at50);
    expect(at25).toBe(60 + 400);
  });

  it('measures the content even when the panel is far taller than it', () => {
    // The general form: the reported height must never be dragged up by the
    // container it is trying to shrink.
    const onNaturalHeight = vi.fn();
    const { container } = renderCard({ autoHeight: true, onNaturalHeight });
    stubLayout(container, { panelPx: 3000, chrome: 60, contentPx: 200 });
    fire();
    expect(onNaturalHeight).toHaveBeenLastCalledWith(260);
  });

  it('includes the panel PADDING, which is operator-configurable', () => {
    // `clientHeight` includes the padding, so a report that left it out would make
    // every panel two paddings short and clip its last row — subtly, and only on
    // panels whose padding somebody had changed.
    const onNaturalHeight = vi.fn();
    const { container } = renderCard({ autoHeight: true, onNaturalHeight });
    stubLayout(container, { panelPx: 1000, chrome: 60, contentPx: 400, padY: 24 });
    fire();
    expect(onNaturalHeight).toHaveBeenLastCalledWith(60 + 24 + 400);
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

/**
 * The title and the panel's own controls on ONE line (operator, 2026-09-01:
 * *"give titles and filters in same line … dont give in seperate lines, for all
 * widgets"*).
 *
 * The title belongs to `PanelCard` and the search/filters belong to the content,
 * so they were two components and therefore two rows. These assert the join by
 * DOM CONTAINMENT — the only form that actually says "same line". A query that
 * merely found both on the page would pass with them stacked, which is the state
 * being fixed.
 */
function Consumer() {
  const slot = usePanelToolbarSlot();
  const bar = <input data-testid="bar" aria-label="Search" />;
  return (
    <div data-testid="body">
      {slot ? createPortal(bar, slot) : bar}
      <p>rows</p>
    </div>
  );
}

describe('PanelCard — the header toolbar slot', () => {
  const renderPanel = () => render(
    <PanelCard title="Active alarms" eyebrow="Alarms" editing={false} width={12} height={8}>
      <Consumer />
    </PanelCard>,
  );

  it('puts the content toolbar in the SAME row as the title', () => {
    const { container } = renderPanel();
    const bar = screen.getByTestId('bar');
    const heading = screen.getByRole('heading', { name: 'Active alarms' });

    // One element contains both: that is what "same line" means structurally.
    const row = heading.closest('div')!.parentElement!;
    expect(row.contains(bar)).toBe(true);
    expect(container.querySelector('.panel-card')!.contains(bar)).toBe(true);
  });

  it('does NOT leave the toolbar in the body, below the title', () => {
    // The state being fixed. `body` is where the content renders; if the portal
    // failed the input would still be there and everything else would pass.
    renderPanel();
    expect(screen.getByTestId('body').contains(screen.getByTestId('bar'))).toBe(false);
  });

  it('renders the toolbar INLINE when there is no PanelCard', () => {
    // A panel mounted on its own must not silently lose its search box — which is
    // exactly how these components are rendered in their own tests.
    render(<Consumer />);
    expect(screen.getByTestId('body').contains(screen.getByTestId('bar'))).toBe(true);
  });
});
