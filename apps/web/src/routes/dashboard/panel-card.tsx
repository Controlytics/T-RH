import type { ReactNode } from 'react';

/**
 * The frame around one dashboard panel inside the grid.
 *
 * It exists because a grid item needs a fixed-height box that scrolls its own
 * content: a card resized smaller than what it holds must clip and scroll, not
 * spill over the card beneath it. `h-full` plus an inner `overflow-auto` is the
 * whole trick, and without it resizing looks broken rather than tight.
 *
 * In edit mode the frame shows a grab cursor and a dashed outline, so it is
 * obvious which regions move — and, when the per-card edit dialog arrives, this is
 * where its affordance goes.
 */
export function PanelCard({
  title, editing, children,
}: {
  title: string;
  editing: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={`flex h-full flex-col overflow-hidden rounded-2xl border bg-white shadow-soft ${
        editing ? 'cursor-grab border-dashed border-slate-400 active:cursor-grabbing' : 'border-slate-200'
      }`}
    >
      <div className="shrink-0 border-b border-slate-100 px-4 py-2">
        <h2 className="truncate text-sm font-semibold text-slate-800" title={title}>{title}</h2>
      </div>
      {/*
        The scroll container. `min-h-0` is load-bearing: a flex child defaults to
        min-height:auto, which refuses to shrink below its content, so without it
        the card grows past the height the grid gave it and overlaps its
        neighbour — which reads as the grid being broken.
      */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {children}
      </div>
    </div>
  );
}
