import {
  useState, useEffect, useRef, useContext, createContext, type ReactNode,
} from 'react';
import {
  PANEL_TINTS, PANEL_SIZES, PANEL_PADDINGS, PANEL_WIDTHS, PANEL_HEIGHTS, MAX_PANEL_TITLE,
  tintFor, sizeFor, paddingFor, namedWidth, namedHeight, type PanelStyle,
} from '@digilog/shared';

/**
 * The frame around one dashboard panel inside the grid.
 *
 * It exists because a grid item needs a fixed-height box that scrolls its own
 * content: a card resized smaller than what it holds must clip and scroll, not
 * spill over the card beneath it.
 *
 * In edit mode it gains a grab cursor, a dashed outline and an Edit button.
 *
 * The operator may set a tint, a content size, the content padding and a custom
 * heading. **The tint styles the card's CHROME only.** Everything inside — status badges,
 * limit lines, out-of-spec highlighting, chart series colours — is untouched and
 * unreachable from here. Those encode compliance state, and a §11 record that
 * looked different depending on who arranged their dashboard would not be a
 * record. The palette itself is bounded and contrast-checked; see
 * @digilog/shared types/panel-style.ts.
 */
/**
 * The header's toolbar slot — a DOM node a panel's own content can render into.
 *
 * Operator, 2026-09-01: *"give titles and filters in same line … dont give in
 * seperate lines, for all widgets"*. The title belongs to `PanelCard` (the
 * operator may rename it) while the search and filters belong to the panel's
 * content, so they lived in two different components and therefore on two lines.
 *
 * A PORTAL rather than lifting the filter state up into `dashboard/index.tsx`:
 * the state is the content's, and hoisting it would put three panels' filters in
 * one component to solve a layout problem. The slot is held as STATE, not a ref,
 * because a ref is still null on the first render and the portal would never
 * mount.
 *
 * `null` when there is no PanelCard around — a panel rendered on its own (as the
 * tests do) then draws its toolbar inline, so it is never left without one.
 */
const PanelToolbarSlot = createContext<HTMLElement | null>(null);

export function usePanelToolbarSlot(): HTMLElement | null {
  return useContext(PanelToolbarSlot);
}

export function PanelCard({
  title, eyebrow, editing, style, width, height, onStyleChange, onSizeChange, children, menu,
  autoHeight = false, onNaturalHeight,
}: {
  /** The panel's built-in heading, used when the operator has not renamed it. */
  title: string;
  /**
   * What KIND of panel this is — "Readings", "Layout", "Trend", "Alarms".
   *
   * Not decoration: four cards of identical chrome, one holding a table and one a
   * floor plan, are hard to tell apart at a glance on a wall display. The eyebrow
   * says which is which before the content has loaded, and it survives the
   * operator renaming the title.
   */
  eyebrow: string;
  editing: boolean;
  style?: PanelStyle;
  /** The card's current grid width and height, for the size controls. */
  width: number;
  height: number;
  onStyleChange?: (next: PanelStyle | undefined) => void;
  onSizeChange?: (w: number, h: number) => void;
  children: ReactNode;
  /**
   * This card's height FOLLOWS ITS CONTENT and is not dragged (operator,
   * 2026-09-01). It reports its natural height upward and the dashboard turns
   * that into grid rows; the Height control below is hidden, because a control
   * that cannot change anything is a decoy.
   */
  autoHeight?: boolean;
  /** Called with the height this card would like to be, in pixels. MUST be
   *  referentially stable — it is an effect dependency. */
  onNaturalHeight?: (px: number) => void;
  /**
   * Extra header controls shown ONLY while arranging — a built widget's Edit and
   * Remove (2026-10-28). Nothing renders outside edit mode.
   */
  menu?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [toolbarEl, setToolbarEl] = useState<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);

  /**
   * Measure what this card WANTS to be, and report it.
   *
   * The observed element is the content wrapper INSIDE the scroll region — the
   * one in natural flow. Observing the card or the scroll region instead is the
   * trap here: both have their border box pinned by the grid cell, so going from
   * 25 rows to 50 grows `scrollHeight` without changing either box, and
   * **ResizeObserver does not fire on a scrollHeight change**. The panel would
   * then only resize when the window did — which is the original complaint with
   * extra steps.
   *
   * `chrome` is everything outside the scroll region's content box (header,
   * borders, the style editor while it is open); `scrollHeight` is the content
   * plus its padding. Their sum is the height at which nothing is clipped and
   * nothing is spare.
   */
  useEffect(() => {
    if (!autoHeight || !onNaturalHeight) return undefined;
    const card = cardRef.current;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (!card || !scroll || !content) return undefined;

    /**
     * **Measure the CONTENT, never `scroll.scrollHeight`** (operator, 2026-09-01:
     * the panel grew from 25 to 50 rows and then would not shrink back).
     *
     * `scrollHeight` is `max(content, clientHeight)`, so a container TALLER than
     * its content reports its own height. That makes it a one-way measurement:
     * growing works, because overflow pushes it above `clientHeight`; shrinking
     * can never work, because the value is pinned to the very height being
     * reduced. The card sat at its 50-row size with an empty band underneath.
     *
     * The content wrapper is a plain block in normal flow, so its box IS the
     * content's natural height whatever the container does. `padY` is read off the
     * scroll region because the panel's padding is operator-configurable, and
     * `clientHeight` already includes it — leaving it out would shrink every panel
     * by two paddings and clip the last row.
     */
    const report = () => {
      const chrome = card.offsetHeight - scroll.clientHeight;
      const cs = getComputedStyle(scroll);
      const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      onNaturalHeight(chrome + padY + content.getBoundingClientRect().height);
    };
    report();

    // jsdom has no ResizeObserver. The one measurement above still happens, so a
    // test rendering this card is not left with a card that never reports.
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(report);
    ro.observe(content);
    return () => ro.disconnect();
    // `open` is a dependency because the style editor sits between the header and
    // the scroll region: opening it changes `chrome` and nothing else would
    // re-measure.
  }, [autoHeight, onNaturalHeight, open]);
  const tint = tintFor(style?.tint);
  const size = sizeFor(style?.size);
  const pad = paddingFor(style?.pad);
  const heading = style?.title ?? title;

  return (
    <div
      ref={cardRef}
      className={`panel-card flex h-full flex-col overflow-hidden rounded-2xl border ${
        editing ? 'cursor-grab border-dashed active:cursor-grabbing' : ''
      }`}
      style={{ backgroundColor: tint.bg, borderColor: tint.border }}
    >
      {/*
        THE RAIL. The card body stays light so the content is readable, which
        leaves a tint almost invisible from across a room; the rail carries the
        colour instead. On the default tint it takes the site theme, so the
        dashboard finally wears whichever of the ten themes is selected.
      */}
      <div className="panel-card__rail" style={{ backgroundColor: tint.rail }} aria-hidden />

      {/* The label plate: a shade deeper than the body, the way an instrument's
          legend sits proud of its face. */}
      {/* `items-center`, not `items-baseline`: this row now holds form controls as
          well as text, and a select aligned on the title's baseline sits low. The
          Edit button already opted out with `self-center`. */}
      {/* `background`, not `backgroundColor`: the default tint's plate is the
          site band GRADIENT since 2026-09-25 (operator: "entire dasboard …
          should colorful"), with `headInk` for the words on it. The seven
          named tints keep their pastel plates. */}
      <div
        className="flex shrink-0 items-center gap-3 border-b px-4 py-2.5"
        style={{ borderColor: tint.border, background: tint.head }}
      >
        <div className="min-w-0">
          <p
            className="text-[0.625rem] font-semibold uppercase leading-none tracking-[0.14em] opacity-75"
            style={{ color: tint.headInk ?? tint.text }}
          >
            {eyebrow}
          </p>
          <h2
            className="mt-1 truncate text-[0.9375rem] font-bold leading-tight"
            style={{ color: tint.headInk ?? tint.text }}
            title={heading}
          >
            {heading}
          </h2>
        </div>
        {/* THE TOOLBAR SLOT. Always rendered, so `ml-auto` here is what pushes the
            Edit button right whether or not the content fills it. `min-w-0` lets
            the controls shrink before the title does — the title truncates, and a
            truncated heading is more readable than a crushed search box. */}
        <div ref={setToolbarEl} className="ml-auto flex min-w-0 flex-nowrap items-center gap-2" />

        {editing && menu}
        {editing && onStyleChange && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="shrink-0 rounded-md border border-slate-300 bg-white/90 px-2 py-0.5 text-[0.6875rem] font-semibold text-slate-700 hover:bg-white"
          >
            {open ? 'Close' : 'Edit'}
          </button>
        )}
      </div>

      {open && onStyleChange && (
        <PanelStyleEditor
          title={title}
          style={style}
          width={width}
          height={height}
          onChange={onStyleChange}
          onSizeChange={onSizeChange}
          autoHeight={autoHeight}
          onDone={() => setOpen(false)}
        />
      )}

      {/*
        The scroll container. `min-h-0` is load-bearing: a flex child defaults to
        min-height:auto, which refuses to shrink below its content, so without it
        the card grows past the height the grid gave it and overlaps its
        neighbour — which reads as the grid being broken.

        The size is applied as `zoom`, NOT `font-size`. The panels size their text
        with absolute Tailwind classes, which do not inherit from a container's
        font-size — a font-size here would be a control that appears to work and
        changes nothing. zoom scales the content, which is why the editor calls it
        "Content size" rather than promising something narrower.

        It sits on the scroll container's CHILD, not the container, so scrolling
        still measures the scaled content correctly.
      */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto" style={{ padding: pad.px }}>
        <div ref={contentRef} style={size.zoom === 1 ? undefined : { zoom: size.zoom }}>
          <PanelToolbarSlot.Provider value={toolbarEl}>
            {children}
          </PanelToolbarSlot.Provider>
        </div>
      </div>
    </div>
  );
}

/**
 * The per-card edit panel: a bounded palette and a heading.
 *
 * Colours are SWATCHES, not a picker, and each swatch previews its own text
 * colour — so the choice being made is visible before it is made. Free hex would
 * let someone paint an out-of-limit card green or set text the shade of its
 * background; the palette is the safeguard, and it is only a safeguard if the UI
 * cannot go around it.
 */
function PanelStyleEditor({
  title, style, width, height, onChange, onSizeChange, onDone, autoHeight = false,
}: {
  title: string;
  style?: PanelStyle;
  width: number;
  height: number;
  onChange: (next: PanelStyle | undefined) => void;
  onSizeChange?: (w: number, h: number) => void;
  onDone: () => void;
  /** Hides the Card height control — this card's height is measured, not chosen. */
  autoHeight?: boolean;
}) {
  const current = style?.tint ?? 'default';

  const set = (patch: Partial<PanelStyle>) => {
    const next: PanelStyle = { ...style, ...patch };
    // A choice equal to the default is stored as ABSENCE, not as a value. Storing
    // 'normal' would pin the card to today's default, so changing that default
    // later would not reach the cards that never chose anything.
    if (next.tint === 'default') delete next.tint;
    if (next.size === 'normal') delete next.size;
    if (next.pad === 'normal') delete next.pad;
    if (!next.title || next.title.trim().length === 0) delete next.title;
    onChange(Object.keys(next).length > 0 ? next : undefined);
  };

  return (
    <div
      className="shrink-0 space-y-2 border-b border-slate-200 bg-white/85 px-4 py-3"
      // Inside a draggable card: without this a drag started on the controls would
      // move the card instead of using them. `draggableCancel` covers the inputs
      // themselves; this covers the padding between them.
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div>
        <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">Colour</p>
        <div className="flex flex-wrap gap-1.5">
          {PANEL_TINTS.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.label}
              aria-label={t.label}
              aria-pressed={current === t.key}
              onClick={() => set({ tint: t.key })}
              className={`h-7 w-10 rounded-md border text-[0.625rem] font-bold ${
                current === t.key ? 'ring-2 ring-slate-800 ring-offset-1' : ''
              }`}
              style={{ backgroundColor: t.bg, borderColor: t.border, color: t.text }}
            >
              Aa
            </button>
          ))}
        </div>
      </div>

      {onSizeChange && (
        // One column when there is no height control, or the width select sits in
        // half a row with a gap beside it where a control used to be.
        <div className={autoHeight ? '' : 'grid grid-cols-2 gap-3'}>
          <div>
            <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
              Card width
            </p>
            {/*
              The same draft dragging writes to, so the two ways of sizing a card
              cannot disagree. A card dragged to a width between two named steps
              shows "Custom" rather than the nearest name — quoting a size the card
              does not have would be worse than admitting it has no name.
            */}
            <select
              className="ctl ctl-sm w-full"
              value={namedWidth(width) ?? 0}
              onChange={(e) => onSizeChange(Number(e.target.value), height)}
            >
              {namedWidth(width) === null && <option value={0}>Custom ({width}/12)</option>}
              {PANEL_WIDTHS.map((w) => <option key={w.w} value={w.w}>{w.label}</option>)}
            </select>
          </div>
          {/*
            NO height control when the height is measured (operator, 2026-09-01).
            Not tidiness: this select would set an `h` that the next measurement
            overwrites within a frame, so it would appear to do nothing — and this
            repo has already written down what an inert control costs (see the
            `SlotColumn` unused-prop note in apps/web/CLAUDE.md). The caption says
            why the control is absent, so its absence does not read as a bug.
          */}
          {autoHeight ? (
            <p className="mt-2 text-[0.6875rem] leading-snug text-slate-500">
              Height follows the content — the card ends at its pagination and
              resizes itself when you change how many rows are shown.
            </p>
          ) : (
            <div>
              <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
                Card height
              </p>
              <select
                className="ctl ctl-sm w-full"
                value={namedHeight(height) ?? 0}
                onChange={(e) => onSizeChange(width, Number(e.target.value))}
              >
                {namedHeight(height) === null && <option value={0}>Custom ({height} rows)</option>}
                {PANEL_HEIGHTS.map((h) => <option key={h.h} value={h.h}>{h.label}</option>)}
              </select>
            </div>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
            Content size
          </p>
          {/* Named "Content size", not "Font size", because zoom scales spacing
              and glyphs along with the text. Calling it what it is beats a label
              that promises something narrower than it delivers. */}
          <select
            className="ctl ctl-sm w-full"
            value={style?.size ?? 'normal'}
            onChange={(e) => set({ size: e.target.value })}
          >
            {PANEL_SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <p className="mb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
            Padding
          </p>
          <select
            className="ctl ctl-sm w-full"
            value={style?.pad ?? 'normal'}
            onChange={(e) => set({ pad: e.target.value })}
          >
            {PANEL_PADDINGS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[0.6875rem] font-semibold uppercase tracking-wide text-slate-500">
          Heading
        </label>
        <input
          className="ctl ctl-sm w-full"
          maxLength={MAX_PANEL_TITLE}
          placeholder={title}
          value={style?.title ?? ''}
          onChange={(e) => set({ title: e.target.value })}
        />
        {/* Clearing the box restores the built-in heading rather than leaving a
            card with no title, which would give no clue which panel it is. */}
        <p className="mt-1 text-[0.6875rem] text-slate-500">Leave empty to use “{title}”.</p>
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={() => { onChange(undefined); onDone(); }}
          className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-slate-700"
        >
          Reset card
        </button>
        <button
          type="button"
          onClick={onDone}
          className="rounded-md bg-slate-800 px-2 py-1 text-xs font-semibold text-white"
        >
          Done
        </button>
      </div>
    </div>
  );
}
