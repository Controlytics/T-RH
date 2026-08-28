import { useState, type ReactNode } from 'react';
import {
  PANEL_TINTS, PANEL_SIZES, PANEL_PADDINGS, MAX_PANEL_TITLE,
  tintFor, sizeFor, paddingFor, type PanelStyle,
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
export function PanelCard({
  title, editing, style, onStyleChange, children,
}: {
  /** The panel's built-in heading, used when the operator has not renamed it. */
  title: string;
  editing: boolean;
  style?: PanelStyle;
  onStyleChange?: (next: PanelStyle | undefined) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const tint = tintFor(style?.tint);
  const size = sizeFor(style?.size);
  const pad = paddingFor(style?.pad);
  const heading = style?.title ?? title;

  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-2xl border shadow-soft ${
        editing ? 'cursor-grab border-dashed active:cursor-grabbing' : ''
      }`}
      style={{ backgroundColor: tint.bg, borderColor: tint.border }}
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b px-4 py-2"
        style={{ borderColor: tint.border }}
      >
        <h2 className="truncate text-sm font-semibold" style={{ color: tint.text }} title={heading}>
          {heading}
        </h2>
        {editing && onStyleChange && (
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className="ml-auto shrink-0 rounded-md border border-slate-300 bg-white/80 px-2 py-0.5 text-[11px] font-semibold text-slate-700 hover:bg-white"
          >
            {open ? 'Close' : 'Edit'}
          </button>
        )}
      </div>

      {open && onStyleChange && (
        <PanelStyleEditor
          title={title}
          style={style}
          onChange={onStyleChange}
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
      <div className="min-h-0 flex-1 overflow-auto" style={{ padding: pad.px }}>
        <div style={size.zoom === 1 ? undefined : { zoom: size.zoom }}>
          {children}
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
  title, style, onChange, onDone,
}: {
  title: string;
  style?: PanelStyle;
  onChange: (next: PanelStyle | undefined) => void;
  onDone: () => void;
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
        <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Colour</p>
        <div className="flex flex-wrap gap-1.5">
          {PANEL_TINTS.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.label}
              aria-label={t.label}
              aria-pressed={current === t.key}
              onClick={() => set({ tint: t.key })}
              className={`h-7 w-10 rounded-md border text-[10px] font-bold ${
                current === t.key ? 'ring-2 ring-slate-800 ring-offset-1' : ''
              }`}
              style={{ backgroundColor: t.bg, borderColor: t.border, color: t.text }}
            >
              Aa
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Content size
          </p>
          {/* Named "Content size", not "Font size", because zoom scales spacing
              and glyphs along with the text. Calling it what it is beats a label
              that promises something narrower than it delivers. */}
          <select
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={style?.size ?? 'normal'}
            onChange={(e) => set({ size: e.target.value })}
          >
            {PANEL_SIZES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Padding
          </p>
          <select
            className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
            value={style?.pad ?? 'normal'}
            onChange={(e) => set({ pad: e.target.value })}
          >
            {PANEL_PADDINGS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
          </select>
        </div>
      </div>

      <div>
        <label className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Heading
        </label>
        <input
          className="w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
          maxLength={MAX_PANEL_TITLE}
          placeholder={title}
          value={style?.title ?? ''}
          onChange={(e) => set({ title: e.target.value })}
        />
        {/* Clearing the box restores the built-in heading rather than leaving a
            card with no title, which would give no clue which panel it is. */}
        <p className="mt-1 text-[11px] text-slate-500">Leave empty to use “{title}”.</p>
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
