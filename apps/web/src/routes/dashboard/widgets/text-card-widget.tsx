/**
 * Text card — a note in the builder's own words. The text is a React TEXT node:
 * never `dangerouslySetInnerHTML`, never markdown, so `<b>x</b>` reads as those
 * eight characters (and the server stripped HTML from it on save anyway, R8-1).
 * Line breaks are kept (`whitespace-pre-wrap`); a long unbroken run wraps inside
 * the card (`overflow-wrap: anywhere`) rather than pushing it sideways. A card
 * keeps the height it is given and scrolls, like the panel it sits in.
 */
import type { CustomWidget } from '@digilog/shared';

export function TextCardWidget({ widget }: { widget: CustomWidget }) {
  return (
    <p
      data-testid="text-card"
      className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-[0.9375rem] leading-relaxed text-slate-800"
    >
      {widget.options.text}
    </p>
  );
}
