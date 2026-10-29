import type { ReactNode } from 'react';
import { ResponsiveGridLayout, getBreakpointFromWidth, useContainerWidth, type Layout } from 'react-grid-layout';
import { GRID_COLUMNS, type LayoutItem } from '@digilog/shared';
import { AUTO_HEIGHT_PANELS, ROW_HEIGHT, MARGIN_Y } from './panel-auto-height';
import { Button } from '@/components/ui/button';

// react-grid-layout ships its own CSS AND expects react-resizable's. Omit either
// and the drag works while the resize corner is invisible — which reads as a
// broken feature rather than a missing import.
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';

/**
 * The dashboard's panels, arranged.
 *
 * DRAG IS OFF UNTIL "Arrange" IS PRESSED. Not a preference — a dashboard someone
 * can rearrange by accidentally dragging a card while trying to scroll on a
 * touchscreen is a dashboard whose layout nobody trusts again. Edit mode also
 * gives the per-card edit affordance an obvious home when that arrives.
 *
 * Only the `lg` layout is ever stored. Narrower breakpoints are derived by the
 * library: storing three layouts would mean an operator arranging a phone view
 * they never look at, and a "why did my desktop layout change" bug the first time
 * someone opened the dashboard on a tablet.
 */

const BREAKPOINTS = { lg: 1200, md: 900, sm: 0 };
const COLS = { lg: GRID_COLUMNS, md: 6, sm: 1 };
// ROW_HEIGHT / MARGIN_Y come from `panel-auto-height` so the geometry the grid
// DRAWS with and the geometry the auto-height maths SOLVES with are the same two
// numbers. Two copies would mis-size every measured panel by a constant, and it
// would look like a rounding bug rather than a duplicated constant.

/**
 * Give every AUTO-HEIGHT panel a WIDTH-ONLY handle.
 *
 * The library's default is `['se']` — the bottom-right corner, which drags both
 * axes. On a card whose height is measured, the vertical half of that drag is
 * immediately undone by the next measurement, so the corner would look broken.
 * `['e']` is the right EDGE: width still drags, height cannot.
 *
 * Per-item `resizeHandles` overrides the grid-level `resizeConfig.handles` in
 * react-grid-layout 2.x. The floorplan is deliberately not listed in
 * `AUTO_HEIGHT_PANELS`, so it keeps the corner and stays draggable in both axes —
 * it is the one panel here where a taller box genuinely shows more.
 */
export function withResizeHandles(
  items: readonly LayoutItem[],
  auto: ReadonlySet<string> = AUTO_HEIGHT_PANELS,
) {
  return items.map((it) => (
    auto.has(it.i) ? { ...it, resizeHandles: ['e' as const] } : it
  ));
}

export function PanelGrid({
  items, editing, saving, children, onStart, onCancel, onSave, onReset, onChange, toolbar,
  canArrange = true, autoIds, editActions, resetLabel = 'Reset to default', saveLabel = 'Save layout',
}: {
  items: LayoutItem[];
  editing: boolean;
  saving: boolean;
  /** One child per layout item, each with a `key` equal to that item's `i`. */
  children: ReactNode;
  onStart: () => void;
  onCancel: () => void;
  onSave: () => void;
  onReset: () => void;
  onChange: (next: LayoutItem[]) => void;
  /** Rendered on its own row BENEATH the Arrange controls — the view toggle. */
  toolbar?: ReactNode;
  /**
   * SUPER_ADMIN only (operator, 2026-08-29). Gates the whole edit session, not
   * just the button: `interactive` below is ANDed with it, so a layout cannot be
   * dragged even if edit mode were somehow entered. The saved arrangement still
   * APPLIES to everyone — this governs who may change it, not who may see it.
   */
  canArrange?: boolean;
  /** This layout's auto-height set (`autoHeightIds`), built widgets included. */
  autoIds?: ReadonlySet<string>;
  /** Extra controls in the edit row (Add widget, Save as role default) — SUPER_ADMIN only. */
  editActions?: ReactNode;
  /**
   * The edit row's words. The home dashboard keeps "Reset to default" and
   * "Save layout"; a BUILT dashboard has no default to reset to and saves a
   * dashboard, not a layout, so its page says "Discard changes" and "Save".
   */
  resetLabel?: string;
  saveLabel?: string;
}) {
  // v2 requires an explicit width. `useContainerWidth` measures the element the
  // ref is attached to and re-measures on resize — the replacement for v1's
  // WidthProvider higher-order component.
  const { width, mounted, containerRef } = useContainerWidth();

  /**
   * The breakpoint the grid is drawing, by react-grid-layout's OWN rule
   * (`width > 1200` is `lg`) from the same width it is given. It used to be
   * state fed by `onBreakpointChange`, which the library fires only on a LATER
   * width change — a grid that mounted at `md` reported `lg` for ever.
   */
  const breakpoint = getBreakpointFromWidth(BREAKPOINTS, width) as keyof typeof COLS;

  /**
   * Drag and resize ONLY at `lg` (ruling R9, 2026-10-29). Only the `lg`
   * arrangement is stored (see `onLayoutChange`), so at `md` a drag moved a
   * card on screen and was then thrown away: Save found nothing changed and
   * the cards snapped back. A 1240px window with the sidebar open is `md`.
   * (On a phone it was already off: precise dragging there destroys layouts.)
   */
  const interactive = canArrange && editing && breakpoint === 'lg';

  return (
    <div className="space-y-2">
      {/* ONE ROW: the view toggle on the left, Arrange (or the edit controls) on
          the right — operator, 2026-08-29. `justify-end` is gone and the right
          hand group is pushed over by an auto margin instead: `mr-auto` on the
          editing hint, `ml-auto` on Arrange. With no toolbar both branches land
          exactly where they did before. */}
      <div className="flex flex-wrap items-center gap-2">
        {toolbar}
        {!editing ? (
          canArrange ? <Button variant="outline" className="ml-auto" onClick={onStart}>Arrange</Button> : null
        ) : (
          <>
            <span className="mr-auto text-xs text-slate-500">
              {breakpoint !== 'lg'
                ? 'Widen the window (or collapse the sidebar) to move and resize cards — the arrangement is saved in the 12-column layout.'
                : 'Drag a card to move it, or drag its bottom-right corner to resize.'}
            </span>
            {editActions}
            <Button variant="outline" disabled={saving} onClick={onReset}>{resetLabel}</Button>
            <Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
            <Button disabled={saving} onClick={onSave}>{saving ? 'Saving…' : saveLabel}</Button>
          </>
        )}
      </div>

      {/* `panel-grid--editing` is what app.css hangs the visible resize handle off.
          The library's own handle is opacity:0 until the grid item is hovered and
          draws a 5px mark that lands on a rounded card's corner — invisible in
          practice, which is what the operator reported. */}
      <div
        ref={containerRef}
        className={editing ? 'panel-grid--editing rounded-xl bg-slate-100/70 p-1 ring-1 ring-inset ring-slate-300' : ''}
      >
        {/* Nothing is rendered until the container has been measured once.
            Laying out against a width of 0 puts every card in column 0 for a
            frame, which reads as the layout having been lost. */}
        {mounted && (
        <ResponsiveGridLayout
          width={width}
          className="layout"
          layouts={{ lg: withResizeHandles(items, autoIds) as Layout }}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={ROW_HEIGHT}
          margin={[16, MARGIN_Y]}
          // react-grid-layout 2.x replaced the flat isDraggable / isResizable /
          // draggableCancel props with these config objects. The v1 names are
          // still accepted by its `legacy` entry point, which this does NOT use.
          dragConfig={{
            enabled: interactive,
            // The whole card is the drag handle, so there is no small target to
            // hunt for — but controls inside a card must still be clickable, and
            // in edit mode a stray click must not start a drag.
            cancel: 'button,a,input,select,textarea',
          }}
          resizeConfig={{ enabled: interactive }}
          onLayoutChange={(current: Layout, all: Partial<Record<string, Layout>>) => {
            // Only `lg` is stored. Writing back a derived md/sm arrangement would
            // overwrite the operator's desktop layout with one the library
            // invented for a narrower screen.
            if (!editing || breakpoint !== 'lg') return;
            const next = (all.lg ?? current).map((l) => ({ i: l.i, x: l.x, y: l.y, w: l.w, h: l.h }));
            onChange(next);
          }}
        >
          {children}
        </ResponsiveGridLayout>
        )}
      </div>
    </div>
  );
}
