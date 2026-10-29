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
