import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import type { LayoutItem } from '@digilog/shared';

/**
 * Does a changed `h` actually reach the SCREEN?
 *
 * Everything else about auto-height is pinned either side of this join:
 * `panel-auto-height.test.ts` covers pixels → rows, and
 * `panel-card-auto-height.test.tsx` covers the measurement. Neither can see
 * whether react-grid-layout propagates a new `layouts` prop into a new rendered
 * height — and if it does not (it holds the layout in its own state, and some
 * versions ignore later prop changes), the measurement would run, `autoRows`
 * would update, and **the panel would never move**. The whole feature would be
 * dead with every other test still green.
 *
 * So this asserts the one thing that cannot be inferred: the inline height RGL
 * writes onto the grid item changes when `h` does.
 */

vi.mock('react-grid-layout', async (importActual) => {
  const actual = await importActual<typeof import('react-grid-layout')>();
  return {
    ...actual,
    // jsdom measures nothing, so the grid would render at width 0 and bail out
    // behind its own `mounted` guard.
    useContainerWidth: () => ({ width: 1200, mounted: true, containerRef: { current: null } }),
  };
});

class StubResizeObserver {
  observe() {}
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;
});
afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
});

const { PanelGrid, withResizeHandles } = await import('../panel-grid');
const { ROW_HEIGHT, MARGIN_Y, capacityPx } = await import('../panel-auto-height');

const item = (h: number): LayoutItem => ({ i: 'telemetry_table', x: 0, y: 0, w: 12, h });

const noop = () => {};
const grid = (items: LayoutItem[]) => (
  <PanelGrid
    items={items}
    editing={false}
    saving={false}
    onStart={noop}
    onCancel={noop}
    onSave={noop}
    onReset={noop}
    onChange={noop}
  >
    <div key="telemetry_table">readings</div>
  </PanelGrid>
);

/** RGL writes `style={{ transform, width, height }}` on each grid item. */
const heightOf = (c: HTMLElement) =>
  (c.querySelector('.react-grid-item') as HTMLElement | null)?.style.height ?? null;

describe('PanelGrid — a changed h reaches the rendered height', () => {
  it('renders the item at the pixel height its row count asks for', () => {
    const { container } = render(grid([item(8)]));
    expect(heightOf(container)).toBe(`${capacityPx(8, ROW_HEIGHT, MARGIN_Y)}px`);
  });

  it('GROWS when h grows — the 25 to 50 case, end to end', () => {
    // This is the assertion the feature stands on. If RGL kept its first layout
    // in state and ignored the prop, this height would not move and nothing else
    // in the suite would notice.
    const { container, rerender } = render(grid([item(8)]));
    const before = heightOf(container);
    rerender(grid([item(20)]));
    const after = heightOf(container);

    expect(after).not.toBe(before);
    expect(parseFloat(after!)).toBeGreaterThan(parseFloat(before!));
    expect(after).toBe(`${capacityPx(20, ROW_HEIGHT, MARGIN_Y)}px`);
  });

  it('SHRINKS again when h shrinks — 50 back to 25', () => {
    const { container, rerender } = render(grid([item(20)]));
    rerender(grid([item(8)]));
    expect(heightOf(container)).toBe(`${capacityPx(8, ROW_HEIGHT, MARGIN_Y)}px`);
  });
});

describe('withResizeHandles', () => {
  it('gives an auto panel the right EDGE only, so height cannot be dragged', () => {
    expect(withResizeHandles([item(8)])[0]).toMatchObject({ resizeHandles: ['e'] });
  });

  it('leaves the floorplan its corner handle', () => {
    // The one panel where dragging taller does something: a drawn plan scales to
    // its box, so it has no content height to fit.
    const plan: LayoutItem = { i: 'telemetry_floorplan', x: 0, y: 0, w: 6, h: 12 };
    expect(withResizeHandles([plan])[0]).not.toHaveProperty('resizeHandles');
  });
});
