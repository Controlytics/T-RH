import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { LayoutItem } from '@digilog/shared';

/**
 * Ruling R9 (2026-10-29): below the `lg` breakpoint, nothing on the grid moves.
 *
 * Only the `lg` (12-column) arrangement is ever stored, so a drag or resize at
 * `md` moved a card on screen and was then silently thrown away — Save found
 * nothing changed and the cards snapped back. A 1240px window with the sidebar
 * open IS `md`. So at any breakpoint but `lg` the grid is not draggable or
 * resizable while editing, and the edit row says why in place of the drag hint.
 *
 * The breakpoint is react-grid-layout's own rule (`width > 1200` is `lg`), read
 * from the measured width — so exactly 1200 is still `md`.
 */

const size = { width: 1300 };
vi.mock('react-grid-layout', async (importActual) => ({
  ...(await importActual<typeof import('react-grid-layout')>()),
  useContainerWidth: () => ({ width: size.width, mounted: true, containerRef: { current: null } }),
}));
class StubResizeObserver { observe() {} disconnect() {} unobserve() {} }
beforeEach(() => { (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver; });
afterEach(() => { delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver; });

const { PanelGrid } = await import('../panel-grid');
const { ROW_HEIGHT, MARGIN_Y } = await import('../panel-auto-height');

const ITEMS: LayoutItem[] = [{ i: 'a', x: 0, y: 0, w: 6, h: 4 }, { i: 'b', x: 6, y: 0, w: 6, h: 4 }];
const NARROW = 'Widen the window (or collapse the sidebar) to move and resize cards — the arrangement is saved in the 12-column layout.';
const DRAG = 'Drag a card to move it, or drag its bottom-right corner to resize.';
const noop = () => {};

function grid(editing = true) {
  return render(
    <PanelGrid items={ITEMS} editing={editing} saving={false} onStart={noop} onCancel={noop} onSave={noop} onReset={noop} onChange={noop}>
      <div key="a">A</div>
      <div key="b">B</div>
    </PanelGrid>,
  );
}
const items = (c: HTMLElement) => Array.from(c.querySelectorAll('.react-grid-item'));
// react-grid-layout always renders the handle; a card that may NOT be resized
// carries `react-resizable-hide` (which hides it), one that may does not.
const resizable = (el: Element) => !el.classList.contains('react-resizable-hide');

describe('PanelGrid below the lg breakpoint', () => {
  it('editing under 1200px: the hint says why, and no card can be dragged or resized', () => {
    size.width = 1199;
    const { container } = grid();
    expect(screen.getByText(NARROW)).toBeInTheDocument();
    expect(screen.queryByText(DRAG)).toBeNull();
    expect(items(container)).toHaveLength(2);
    for (const it of items(container)) {
      expect(it.classList.contains('react-draggable')).toBe(false);
      expect(resizable(it)).toBe(false);
    }
  });

  it('exactly 1200px is still md (react-grid-layout needs MORE than 1200 for lg)', () => {
    size.width = 1200;
    const { container } = grid();
    expect(screen.getByText(NARROW)).toBeInTheDocument();
    for (const it of items(container)) expect(resizable(it)).toBe(false);
  });

  it('the narrow rule covers the phone breakpoint too', () => {
    size.width = 600;
    const { container } = grid();
    expect(screen.getByText(NARROW)).toBeInTheDocument();
    for (const it of items(container)) expect(it.classList.contains('react-draggable')).toBe(false);
  });

  it('editing at lg: the drag hint, and every card drags and resizes as before', () => {
    size.width = 1201;
    const { container } = grid();
    expect(screen.getByText(DRAG)).toBeInTheDocument();
    expect(screen.queryByText(NARROW)).toBeNull();
    for (const it of items(container)) {
      expect(it.classList.contains('react-draggable')).toBe(true);
      expect(resizable(it)).toBe(true);
    }
  });

  it('not editing: no hint and nothing draggable at any width', () => {
    size.width = 1300;
    const { container } = grid(false);
    expect(screen.queryByText(DRAG)).toBeNull();
    expect(screen.queryByText(NARROW)).toBeNull();
    for (const it of items(container)) {
      expect(it.classList.contains('react-draggable')).toBe(false);
      expect(resizable(it)).toBe(false);
    }
  });
});

/**
 * Ruling F-I5 (final fix wave, revising R9-3): `md` is a 900–1,200 px container —
 * a 1,240 px window with the sidebar open, the operator's own — and it drew the
 * 12-column arrangement on SIX columns: react-grid-layout cloned lg, clamped every
 * item that ran past column 6 and pushed the collisions down, so a row of four
 * quarters came out as a staircase with holes. `md` is 12 columns now: the lg
 * arrangement exactly, no derivation, no rounding.
 */
describe('PanelGrid at md draws the stored lg arrangement', () => {
  const MARGIN_X = 16;
  // A quarter row, a third row, a half row, and one dragged odd width at an odd column.
  const ROWS: LayoutItem[] = [
    { i: 'q1', x: 0, y: 0, w: 3, h: 4 }, { i: 'q2', x: 3, y: 0, w: 3, h: 4 },
    { i: 'q3', x: 6, y: 0, w: 3, h: 4 }, { i: 'q4', x: 9, y: 0, w: 3, h: 4 },
    { i: 't1', x: 0, y: 4, w: 4, h: 4 }, { i: 't2', x: 4, y: 4, w: 4, h: 4 }, { i: 't3', x: 8, y: 4, w: 4, h: 4 },
    { i: 'h1', x: 0, y: 8, w: 6, h: 4 }, { i: 'h2', x: 6, y: 8, w: 6, h: 4 },
    { i: 'odd', x: 2, y: 12, w: 5, h: 4 },
  ];
  const drawn = (onChange: (n: LayoutItem[]) => void = noop, editing = false) => render(
    <PanelGrid items={ROWS} editing={editing} saving={false} onStart={noop} onCancel={noop} onSave={noop} onReset={noop} onChange={onChange}>
      {ROWS.map((r) => <div key={r.i}>{r.i}</div>)}
    </PanelGrid>,
  );
  /** Each card's pixel box as react-grid-layout positions it. */
  const boxes = (c: HTMLElement) => items(c).map((el) => {
    const style = (el as HTMLElement).style;
    const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(style.transform);
    if (!m) throw new Error(`no transform on ${el.textContent}: "${style.transform}"`);
    return { i: el.textContent ?? '', left: Number(m[1]), top: Number(m[2]), width: parseFloat(style.width), height: parseFloat(style.height) };
  });
  /** Back to grid units on a 12-column grid of this width — react-grid-layout's own formulas, inverted. */
  const toGrid = (b: ReturnType<typeof boxes>[number], width: number) => {
    const col = (width - MARGIN_X * 11 - MARGIN_X * 2) / 12;
    return {
      i: b.i,
      x: Math.round((b.left - MARGIN_X) / (col + MARGIN_X)),
      w: Math.round((b.width + MARGIN_X) / (col + MARGIN_X)),
      y: Math.round((b.top - MARGIN_Y) / (ROW_HEIGHT + MARGIN_Y)),
      h: Math.round((b.height + MARGIN_Y) / (ROW_HEIGHT + MARGIN_Y)),
    };
  };
  const overlap = (a: ReturnType<typeof boxes>[number], b: ReturnType<typeof boxes>[number]) =>
    a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

  it.each([1192, 960, 901])('at a %i px container (md): every card where lg puts it, none overlapping', (width) => {
    size.width = width;
    const { container } = drawn();
    const b = boxes(container);
    expect(b).toHaveLength(ROWS.length);
    expect(b.map((x) => toGrid(x, width)).sort((p, q) => p.i.localeCompare(q.i)))
      .toEqual(ROWS.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })).sort((p, q) => p.i.localeCompare(q.i)));
    for (let p = 0; p < b.length; p += 1) {
      for (let q = p + 1; q < b.length; q += 1) expect(overlap(b[p], b[q]), `${b[p].i} / ${b[q].i}`).toBe(false);
    }
  });

  it('editing at md writes nothing back, even when the library re-packs the cards (the lg-only save guard)', () => {
    // A stored card with empty rows above it: the library compacts it upward on
    // screen and reports a CHANGED layout. Only an lg arrangement is ever saved.
    const gap: LayoutItem[] = [{ i: 'a', x: 0, y: 0, w: 6, h: 4 }, { i: 'b', x: 6, y: 20, w: 6, h: 4 }];
    const onChange = vi.fn();
    size.width = 1000;
    render(
      <PanelGrid items={gap} editing saving={false} onStart={noop} onCancel={noop} onSave={noop} onReset={noop} onChange={onChange}>
        <div key="a">A</div>
        <div key="b">B</div>
      </PanelGrid>,
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('a resize from md to lg while editing saves the lg items unchanged', () => {
    const onChange = vi.fn();
    size.width = 1000;
    const view = drawn(onChange, true);
    // Nothing is written back while the grid is at md (the lg-only save guard).
    expect(onChange).not.toHaveBeenCalled();
    size.width = 1300;
    view.rerender(
      <PanelGrid items={ROWS} editing saving={false} onStart={noop} onCancel={noop} onSave={noop} onReset={noop} onChange={onChange}>
        {ROWS.map((r) => <div key={r.i}>{r.i}</div>)}
      </PanelGrid>,
    );
    expect(screen.getByText(DRAG)).toBeInTheDocument();
    // …and back to md: whatever the library reports there is never saved as anything but lg.
    size.width = 1000;
    view.rerender(
      <PanelGrid items={ROWS} editing saving={false} onStart={noop} onCancel={noop} onSave={noop} onReset={noop} onChange={onChange}>
        {ROWS.map((r) => <div key={r.i}>{r.i}</div>)}
      </PanelGrid>,
    );
    expect(screen.getByText(NARROW)).toBeInTheDocument();
    for (const [next] of onChange.mock.calls as [LayoutItem[]][]) {
      expect([...next].sort((p, q) => p.i.localeCompare(q.i)))
        .toEqual(ROWS.map(({ i, x, y, w, h }) => ({ i, x, y, w, h })).sort((p, q) => p.i.localeCompare(q.i)));
    }
  });
});
