import { useState, type ReactNode } from 'react';
import { ResponsiveGridLayout, useContainerWidth, type Layout } from 'react-grid-layout';
import { GRID_COLUMNS, type LayoutItem } from '@digilog/shared';
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
const ROW_HEIGHT = 40;

export function PanelGrid({
  items, editing, saving, children, onStart, onCancel, onSave, onReset, onChange, toolbar,
  canArrange = true,
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
}) {
  const [breakpoint, setBreakpoint] = useState<keyof typeof COLS>('lg');
  // v2 requires an explicit width. `useContainerWidth` measures the element the
  // ref is attached to and re-measures on resize — the replacement for v1's
  // WidthProvider higher-order component.
  const { width, mounted, containerRef } = useContainerWidth();

  // Precise dragging on a phone is a way to destroy a layout by accident, not a
  // feature. Resizing is off there for the same reason.
  const interactive = canArrange && editing && breakpoint !== 'sm';

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
              {breakpoint === 'sm'
                ? 'Rearranging is disabled on a narrow screen — open the dashboard wider to move cards.'
                : 'Drag a card to move it, or drag its bottom-right corner to resize.'}
            </span>
            <Button variant="outline" disabled={saving} onClick={onReset}>Reset to default</Button>
            <Button variant="outline" disabled={saving} onClick={onCancel}>Cancel</Button>
            <Button disabled={saving} onClick={onSave}>{saving ? 'Saving…' : 'Save layout'}</Button>
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
          layouts={{ lg: items as Layout }}
          breakpoints={BREAKPOINTS}
          cols={COLS}
          rowHeight={ROW_HEIGHT}
          margin={[16, 16]}
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
          onBreakpointChange={(bp: string) => setBreakpoint(bp as keyof typeof COLS)}
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
