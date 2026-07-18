import { useEffect } from 'react';

/**
 * App-wide horizontal "grab to pan" for wide tables/grids/lists.
 *
 * The problem it solves: every data table in the app wraps itself in a native
 * `overflow-x-auto` (or `overflow-auto`) scroll container. Native browsers
 * already support **Shift + mouse-wheel** and **touchpad horizontal gestures**
 * on these containers, but with a plain mouse the ONLY way to scroll
 * horizontally is to grab the thin bottom scrollbar — which is the UX
 * complaint. This hook adds **click-and-drag panning** on top, so the user can
 * grab anywhere in the table body and drag left/right.
 *
 * Design notes:
 * - Mounted ONCE in AppLayout via document-level delegation, so it covers every
 *   current and future scroll container with zero per-page wiring.
 * - **Mouse only** (`pointerType === 'mouse'`). Touch / pen keep their native
 *   gestures so we never fight the OS's momentum scrolling or trap vertical
 *   page scroll on tablets.
 * - Only engages on containers that ACTUALLY overflow horizontally
 *   (`scrollWidth > clientWidth`) — a vertical-only modal body is ignored.
 * - A drag only "activates" past a small threshold, so a normal click on a row
 *   checkbox / action button / link still works; the click that the browser
 *   fires after a *real* drag is suppressed so dragging over a row never
 *   triggers its row/button handler.
 * - Skips the bottom scrollbar gutter so it doesn't fight the native scrollbar.
 *
 * Plain (no-Shift) vertical wheel is intentionally NOT hijacked: tables can be
 * tall, and stealing vertical wheel would trap the page scroll while the cursor
 * is over the grid.
 */
const SCROLL_SELECTOR = '.overflow-x-auto, .overflow-auto';
const DRAG_THRESHOLD = 5; // px of movement before a press becomes a pan
const SCROLLBAR_GUTTER = 18; // px at the bottom edge reserved for the native scrollbar

export function useDragScroll() {
  useEffect(() => {
    let el: HTMLElement | null = null;
    let startX = 0;
    let startScrollLeft = 0;
    let dragging = false;
    let suppressNextClick = false;

    const reset = () => {
      if (el && dragging) {
        el.style.cursor = '';
        el.style.removeProperty('user-select');
      }
      el = null;
      dragging = false;
    };

    const onPointerDown = (e: PointerEvent) => {
      // A fresh interaction clears any stale "suppress click" left by a drag
      // that ended without a trailing click.
      suppressNextClick = false;
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      const target = e.target as HTMLElement | null;
      // Opt-out: interactive surfaces with their own pointer model (e.g. the
      // cleaning-profile node-graph canvas) mark themselves `data-no-drag-pan`
      // so this generic pan doesn't fight node-dragging.
      if (target?.closest('[data-no-drag-pan]')) return;
      const container = target?.closest(SCROLL_SELECTOR) as HTMLElement | null;
      if (!container) return;
      if (container.scrollWidth <= container.clientWidth) return; // no horizontal overflow
      // Ignore presses on the native horizontal scrollbar gutter.
      const rect = container.getBoundingClientRect();
      if (e.clientY > rect.bottom - SCROLLBAR_GUTTER) return;
      el = container;
      startX = e.clientX;
      startScrollLeft = container.scrollLeft;
      dragging = false;
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!el) return;
      const dx = e.clientX - startX;
      if (!dragging) {
        if (Math.abs(dx) < DRAG_THRESHOLD) return;
        dragging = true;
        el.style.cursor = 'grabbing';
        el.style.setProperty('user-select', 'none');
      }
      el.scrollLeft = startScrollLeft - dx;
      e.preventDefault(); // stop text selection while panning
    };

    const onPointerUp = () => {
      if (dragging) suppressNextClick = true; // swallow the click that follows a real drag
      reset();
    };

    const onClickCapture = (e: MouseEvent) => {
      if (suppressNextClick) {
        suppressNextClick = false;
        e.stopPropagation();
        e.preventDefault();
      }
    };

    document.addEventListener('pointerdown', onPointerDown, { passive: true });
    document.addEventListener('pointermove', onPointerMove, { passive: false });
    document.addEventListener('pointerup', onPointerUp, { passive: true });
    document.addEventListener('pointercancel', reset, { passive: true });
    document.addEventListener('click', onClickCapture, { capture: true });

    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('pointercancel', reset);
      document.removeEventListener('click', onClickCapture, { capture: true } as any);
    };
  }, []);
}
