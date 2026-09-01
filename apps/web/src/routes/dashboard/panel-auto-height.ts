import type { LayoutItem } from '@digilog/shared';

/**
 * Dashboard panels whose HEIGHT follows their content instead of being dragged.
 *
 * Operator, 2026-09-01: "every widget size should be upto pagination only, when
 * user dragged its showing empty space … if user increased 25 to 50 then widgets
 * should adjust upto 50 records in one view, if again he made 25 then size should
 * be adjusted automatically". So a panel ends at its pagination bar, always, and
 * a page-size change resizes it with no drag at all.
 *
 * The height is DERIVED AT RENDER AND NEVER STORED. `role_configs` /
 * `user_configs` keep whatever `h` they had; {@link keepStoredHeights} carries it
 * through a save untouched. Persisting a measured height would bake "however many
 * rows happened to be on screen when somebody pressed Save" into a layout every
 * viewer inherits — and it would go stale the moment anyone changed the page size,
 * which is the whole thing this feature removes.
 */

/**
 * Only panels with a NATURAL content height belong here.
 *
 * `telemetry_floorplan` is deliberately absent (operator, 2026-09-01): a drawn
 * plan has no natural height — it scales to whatever box it is given, so "fit the
 * content" is undefined for it and a bigger box genuinely shows the rooms bigger.
 * It keeps its corner handle and its Height dropdown. It is the ONLY panel on this
 * dashboard where dragging taller does something.
 *
 * Web-side rather than a field on `PANELS` in `@digilog/shared`: that catalogue is
 * a stored contract the API validates role configs against, and how tall a card
 * draws is no business of the server's.
 */
export const AUTO_HEIGHT_PANELS: ReadonlySet<string> = new Set([
  'telemetry_table',
  'dashboard_alarms',
]);

/** Must match the `rowHeight` and `margin` given to the grid, or every panel is
 *  mis-sized by a constant. Imported by `panel-grid.tsx` so there is one pair. */
export const ROW_HEIGHT = 40;
export const MARGIN_Y = 16;

/**
 * A panel never collapses below this, even with nothing in it. The alarms panel is
 * empty whenever the plant is healthy — which is most of the time — and a card
 * shrunk to a title bar reads as a rendering fault rather than as good news.
 */
export const MIN_AUTO_ROWS = 4;

/**
 * The pixel height react-grid-layout gives an item of `rows` rows.
 *
 * Its own geometry: rows are `ROW_HEIGHT` tall with `MARGIN_Y` BETWEEN them, so
 * there are `rows - 1` gaps, not `rows`. Getting that off by one gap makes every
 * panel drift further from its content the taller it gets — the kind of error that
 * looks like a rounding problem and is not.
 */
export function capacityPx(rows: number, rowHeight = ROW_HEIGHT, marginY = MARGIN_Y): number {
  return rows * rowHeight + (rows - 1) * marginY;
}

/** The fewest whole rows that can hold `px`. The inverse of {@link capacityPx}. */
export function rowsForHeight(px: number, rowHeight = ROW_HEIGHT, marginY = MARGIN_Y): number {
  if (!Number.isFinite(px) || px <= 0) return MIN_AUTO_ROWS;
  return Math.max(MIN_AUTO_ROWS, Math.ceil((px + marginY) / (rowHeight + marginY)));
}

/**
 * How much MORE than a whole row must come free before a panel shrinks.
 *
 * The asymmetry is the entire mechanism, and the reason is worth stating because
 * the obvious version does nothing: "grow when it overflows, shrink when a whole
 * row is free" is NOT hysteresis, since `rowsForHeight` is the exact inverse of
 * `capacityPx` — the band it holds in is precisely the band that already maps to
 * the current row count, so the two rules fire on the same pixel. It reads like a
 * deadband and is a no-op. (Found by mutation testing on 2026-09-01: deleting the
 * whole branch changed no behaviour and failed no test.)
 *
 * Shrinking must therefore be STRICTLY harder than growing. Half a row of slack
 * means a content height flipping across a row boundary — 432px then 433px —
 * settles at the taller of the two instead of alternating forever.
 */
const SHRINK_SLACK_PX = ROW_HEIGHT / 2;

/**
 * The row count to settle on, damped so it cannot oscillate.
 *
 * The loop this guards against is not hypothetical: the readings table's Area and
 * Location cells are `line-clamp-2`, so a width change re-wraps them and moves the
 * height by a few pixels — and a panel that grows tall enough to summon the PAGE
 * scrollbar narrows its own container, which feeds straight back into
 * `useContainerWidth` and the wrap. Undamped, that flips between two heights
 * forever, each flip a React render.
 *
 * @param current the rows currently allocated, or null before the first measurement
 * @param px the content's natural height
 */
export function nextRows(current: number | null, px: number): number {
  const wanted = rowsForHeight(px);
  if (current === null) return wanted;
  // Overflow beats everything: a clipped row is worse than an empty one.
  if (px > capacityPx(current)) return wanted;
  // Shrink only once a whole row PLUS the slack has come free.
  if (px + SHRINK_SLACK_PX <= capacityPx(current - 1)) return wanted;
  return current;
}

/**
 * Overlay the measured heights onto the stored layout, for RENDER only.
 *
 * A panel with no measurement yet keeps its stored `h`, so the first paint uses
 * the arrangement someone saved rather than snapping from a default.
 */
export function applyAutoHeights(
  items: readonly LayoutItem[],
  measured: Readonly<Record<string, number>>,
): LayoutItem[] {
  return items.map((it) => {
    if (!AUTO_HEIGHT_PANELS.has(it.i)) return it;
    const rows = measured[it.i];
    return typeof rows === 'number' && rows > 0 ? { ...it, h: rows } : it;
  });
}

/**
 * Strip the derived heights back out before the layout is SAVED.
 *
 * react-grid-layout reports whatever height an item currently has, so without this
 * every save would write the measured value into `role_configs` — and the next
 * person to open the dashboard would inherit a height that described one moment's
 * page size. An auto panel that is not in `stored` (a newly added one) keeps what
 * the grid reported; there is nothing better to fall back to.
 */
export function keepStoredHeights(
  next: readonly LayoutItem[],
  stored: readonly LayoutItem[],
): LayoutItem[] {
  const before = new Map(stored.map((it) => [it.i, it.h]));
  return next.map((it) => {
    if (!AUTO_HEIGHT_PANELS.has(it.i)) return it;
    const h = before.get(it.i);
    return typeof h === 'number' ? { ...it, h } : it;
  });
}
