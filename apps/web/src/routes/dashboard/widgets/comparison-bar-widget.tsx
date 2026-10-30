/**
 * Comparison bars — each instrument's latest value of each key, side by side.
 * The decisions (gaps, colours, the cap, the tooltip) are `comparison-model.ts`;
 * this file draws them and says how many instruments it drew. Present state
 * only: no period, no window.
 */
import { useMemo, useState } from 'react';
import type { CustomWidget } from '@digilog/shared';
import { useSensorWords } from '@/hooks/use-failure-text';
import { LazyEChart } from './charts/lazy-echart';
import { COMPARISON_HEIGHT, buildComparisonOption, codeAxis, comparisonModel } from './comparison-model';
import type { WidgetSelection } from './use-widget-data';
import {
  CapNote, LOAD_FAILED, NO_INSTRUMENTS, NO_KEY_YET, NoReadingsNote, WidgetMessage, useBoxWidth, useWidgetRows,
} from './widget-common';

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
  // Only how the codes stand reaches the option, so a resize that does not
  // change it does not redraw.
  const { rotate, interval } = codeAxis(model.codes, width);
  const option = useMemo(() => buildComparisonOption(model, { rotate, interval }), [signature, rotate, interval]);

  if (loading) return <WidgetMessage>Loading…</WidgetMessage>;
  if (error) return <WidgetMessage tone="error">{LOAD_FAILED}</WidgetMessage>;
  if (empty) return <WidgetMessage>{NO_INSTRUMENTS}</WidgetMessage>;
  if (model.codes.length === 0) return <WidgetMessage>{NO_KEY_YET}</WidgetMessage>;

  return (
    <div className="space-y-2">
      <CapNote shown={model.codes.length} total={model.total} noun="instruments" />
      <NoReadingsNote labels={model.unsent} />
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
