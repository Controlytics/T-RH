/**
 * Comparison bars — each instrument's latest value of each key, side by side.
 * The decisions (gaps, colours, the cap, the tooltip) are `comparison-model.ts`;
 * this file draws them and says how many instruments it drew. Present state
 * only: no period, no window.
 */
import { useEffect, useMemo, useState } from 'react';
import type { CustomWidget } from '@digilog/shared';
import { useSensorWords } from '@/hooks/use-failure-text';
import { LazyEChart } from './charts/lazy-echart';
import { COMPARISON_HEIGHT, buildComparisonOption, comparisonModel, labelsTurn } from './comparison-model';
import type { WidgetSelection } from './use-widget-data';
import { CapNote, LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, WidgetMessage, useWidgetRows } from './widget-common';

export function ComparisonBarWidget({ widget, selection }: { widget: CustomWidget; selection: WidgetSelection }) {
  const { rows, loading, error, empty } = useWidgetRows(widget, selection);
  const words = useSensorWords();
  const model = comparisonModel(rows, widget.keys, words);
  // Keyed on the model's CONTENT, never on object identity: every poll (and, in
  // selection mode, every render) hands new arrays with the same content, and a
  // new option is a full redraw that also closes an open tooltip.
  const signature = JSON.stringify(model);
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useBoxWidth(box);
  // Only whether the codes turn reaches the option, so a resize that does not
  // change it does not redraw.
  const turned = labelsTurn(model.codes, width);
  const option = useMemo(() => buildComparisonOption(model, turned), [signature, turned]);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (model.codes.length === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;

  return (
    <div className="space-y-2">
      <CapNote shown={model.codes.length} total={model.total} noun="instruments" />
      <div ref={setBox}>
        <LazyEChart
          option={option}
          height={COMPARISON_HEIGHT}
          ariaLabel={`${widget.title}: ${model.series.map((s) => s.name).join(', ')} for ${model.codes.length} instruments`}
        />
      </div>
    </div>
  );
}

/** The element's width in whole px, followed as the panel is resized; null until measured. */
function useBoxWidth(el: HTMLElement | null): number | null {
  const [width, setWidth] = useState<number | null>(null);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.round(entry.contentRect.width)));
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);
  return width;
}
