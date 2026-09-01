import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { TimeseriesTableCard, pillTone, rowTone, type SlotColumn } from '../timeseries-table-card';
import type { TableRow as PivotRow } from '../trend-series';

/**
 * The restyled "Time Series (Raw Readings)" card (2026-09-01).
 *
 * Everything asserted here is a §11 claim rather than styling, and every one of
 * them is the kind of defect that looks entirely fine on a rendered page:
 *
 * 1. **A colour on this card is a verdict.** The operator reference image is
 *    arbitrary — it paints 24.2 °C red one row below a green 24.5 °C, and gives
 *    one row a red temperature beside a green humidity with no bound that could
 *    explain either. Reproducing those colours would assert excursions that
 *    never happened. Each pill is coloured from its OWN slot's reading against
 *    the bounds the SERVER resolved.
 *
 * 2. **Green must mean "checked, and inside the bound".** A bound the
 *    instrument switches off (`Enable_Temp_NMT` = 0) arrives NULL, and where
 *    NOTHING is checking a reading the pill has to stay neutral. The three ways
 *    to reach that state — no bounds administered, an extra telemetry key, and
 *    the moment before the overview has loaded — are pinned separately, because
 *    they arrive by different routes and only the first is obvious.
 *
 * 3. **A half-open band IS judged.** With `tempMax` nulled and `tempMin` in
 *    force the alarm evaluator still judges that reading and still raises a
 *    CRITICAL on a breach of the surviving bound. This is a deliberate
 *    narrowing of "a null bound renders neutral": neutral means NO bound is in
 *    force, not "one of the two is missing". A neutral pill there would have
 *    the browser contradict the alarm printed beside it.
 *
 * 4. **The timestamp is administered.** Format, clock and TIMEZONE come from
 *    `/api/config/datetime/current` through the page's `useDatetimeFormat`
 *    formatter, injected here. The cell called `new Date(row.ts).toLocaleString()`
 *    until this restyle, which silently printed the browser's own zone on a page
 *    that printed the administered one everywhere else. Asserted with an
 *    injected formatter whose output no `toLocaleString` could ever produce.
 *
 * 5. **The fault word is administered**, never a literal. It is passed in from
 *    the config-backed `useSensorWords()`.
 *
 * `useExportOptions` is stubbed to allow PDF only — the role gate is that
 * hook's own concern and is tested where it lives.
 */

vi.mock('@/hooks/use-export-options', () => ({
  useExportOptions: () => ({ pdf: true, excel: false }),
}));

const TS = '2026-09-01T04:50:00.000Z';

/** Deliberately unlike ANY locale output, so a `toLocaleString` regression
 *  cannot coincidentally satisfy the assertion. */
const fmt = (ts: string) => `ADMIN-FMT<${ts}>`;

function tempSlot(over: Partial<SlotColumn> = {}): SlotColumn {
  return {
    key: 'temp', heading: 'Temperature (°C)', unit: '°C', decimals: 1,
    min: 18, max: 25, accent: '#2a78d6', icon: <span data-testid="temp-glyph" />, last: 24.5, ...over,
  };
}

function humidSlot(over: Partial<SlotColumn> = {}): SlotColumn {
  return {
    key: 'humidity', heading: 'Humidity (%RH)', unit: '%RH', decimals: 0,
    min: 40, max: 60, accent: '#eb6834', icon: <span data-testid="humid-glyph" />, last: 51, ...over,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof TimeseriesTableCard>> = {}) {
  const rows: PivotRow[] = [{ ts: TS, values: { temp: 24.5, humidity: 51 }, errors: {} }];
  return render(
    <TimeseriesTableCard
      rows={rows}
      slots={[tempSlot(), humidSlot()]}
      extraKeys={[]}
      extraDecimals={2}
      failureWord="Error"
      formatTs={fmt}
      onExportPdf={() => {}}
      page={1}
      pageSize={25}
      totalItems={1}
      onPageChange={() => {}}
      {...props}
    />,
  );
}

const toneOf = (key: string) => screen.getByTestId(`ts-value-${key}`).getAttribute('data-tone');

describe('pillTone — the verdict behind every colour on the card', () => {
  it('is `out` for a reading above its high bound', () => {
    expect(pillTone(26, 18, 25)).toBe('out');
  });

  it('is `out` for a reading below its low bound', () => {
    expect(pillTone(17, 18, 25)).toBe('out');
  });

  it('is `in` for a reading inside both bounds', () => {
    expect(pillTone(24.5, 18, 25)).toBe('in');
  });

  /**
   * The case constraint 2 exists for: NOTHING is judging this reading, so it
   * must not be dressed as a pass.
   */
  it('is `unjudged` when NEITHER bound is in force', () => {
    expect(pillTone(24.5, null, null)).toBe('unjudged');
  });

  /**
   * The deliberate narrowing. `Enable_Temp_NMT` = 0 nulls the high bound alone;
   * the low bound is still administered and the alarm evaluator still judges
   * against it. Neutral here would have this card say "not checked" about a
   * reading that can raise a CRITICAL.
   */
  it('is `in` for a passing reading in a half-open band (one bound switched off)', () => {
    expect(pillTone(24.5, 18, null)).toBe('in');
    expect(pillTone(24.5, null, 25)).toBe('in');
  });

  it('still breaches the bound that survives in a half-open band', () => {
    expect(pillTone(26, null, 25)).toBe('out');
    expect(pillTone(17, 18, null)).toBe('out');
  });

  it('is `unjudged` for an absent or non-finite reading', () => {
    expect(pillTone(null, 18, 25)).toBe('unjudged');
    expect(pillTone(undefined, 18, 25)).toBe('unjudged');
    expect(pillTone(Number.NaN, 18, 25)).toBe('unjudged');
  });

  /** A 0 is a real bound on this installation — see the alarm-limits note in
   *  root CLAUDE.md. It must not be read as "unset". */
  it('treats a bound of 0 as a real bound, not as unset', () => {
    expect(pillTone(5, null, 0)).toBe('out');
    expect(pillTone(-1, 0, null)).toBe('out');
    expect(pillTone(0, 0, null)).toBe('in');
  });
});

describe('rowTone — the row edge and its dot', () => {
  it('lets a breach outrank a fault on the same row', () => {
    expect(rowTone(['out', 'in'], true)).toBe('out');
  });

  it('lets a fault outrank a pass on the same row', () => {
    expect(rowTone(['in'], true)).toBe('fault');
  });

  it('is `in` only when something actually passed', () => {
    expect(rowTone(['in', 'unjudged'], false)).toBe('in');
  });

  it('stays neutral when nothing on the row was judged', () => {
    expect(rowTone(['unjudged', 'unjudged'], false)).toBe('unjudged');
  });
});

describe('TimeseriesTableCard rendering', () => {
  it('gives a value outside its limit the out-of-limit treatment, and the row with it', () => {
    renderCard({
      rows: [{ ts: TS, values: { temp: 26.4, humidity: 51 }, errors: {} }],
    });
    expect(toneOf('temp')).toBe('out');
    // The humidity beside it is inside its own bounds and stays green — the
    // reference image's row-wide red is exactly what must NOT happen.
    expect(toneOf('humidity')).toBe('in');
    expect(screen.getByTestId('ts-row').getAttribute('data-tone')).toBe('out');
  });

  it('does NOT show a value as in-limit when both of its bounds are null', () => {
    renderCard({ slots: [tempSlot({ min: null, max: null }), humidSlot()] });
    expect(toneOf('temp')).toBe('unjudged');
    expect(toneOf('temp')).not.toBe('in');
  });

  /**
   * The loading path. `trend.overview` is undefined until it lands, so the page
   * passes `undefined` bounds — which must read as "not judged yet", never as a
   * page full of green pills that resolve into breaches a second later.
   */
  it('does NOT show a value as in-limit while the limits have not loaded', () => {
    renderCard({ slots: [tempSlot({ min: undefined, max: undefined }), humidSlot()] });
    expect(toneOf('temp')).toBe('unjudged');
  });

  /**
   * The three tests below close the ROW half of "no bound can ever render
   * green". The pill is not the only green signal on a row — the left edge bar
   * and the status dot are too, and both are keyed off the row's `data-tone`,
   * so asserting it covers all three marks at once.
   *
   * They matter because the row tone is reached by a DIFFERENT route from the
   * pill: `rowTone()` collapses the cell verdicts, and the extra-key branch
   * does not call `pillTone` at all — it passes `unjudged` as a literal. A
   * mutation to `pillTone`'s return alone would leave that branch untouched,
   * so the pill tests cannot stand in for these.
   *
   * All three no-bound routes are covered: bounds administered as null, bounds
   * not loaded yet, and a row holding nothing but extra keys.
   */
  it('never paints a row green when NOTHING on it is judged', () => {
    renderCard({ slots: [tempSlot({ min: null, max: null }), humidSlot({ min: null, max: null })] });
    expect(toneOf('temp')).toBe('unjudged');
    expect(toneOf('humidity')).toBe('unjudged');
    // Covers the left edge bar and the dot, which read this same value.
    expect(screen.getByTestId('ts-row').getAttribute('data-tone')).toBe('unjudged');
  });

  it('never paints a row green while the limits have not loaded', () => {
    renderCard({
      slots: [
        tempSlot({ min: undefined, max: undefined }),
        humidSlot({ min: undefined, max: undefined }),
      ],
    });
    expect(screen.getByTestId('ts-row').getAttribute('data-tone')).toBe('unjudged');
  });

  it('never paints a row green when it holds only extra keys', () => {
    renderCard({
      slots: [tempSlot({ key: null }), humidSlot({ key: null })],
      extraKeys: ['co2'],
      rows: [{ ts: TS, values: { co2: 415.25 }, errors: {} }],
    });
    expect(toneOf('co2')).toBe('unjudged');
    expect(screen.getByTestId('ts-row').getAttribute('data-tone')).toBe('unjudged');
  });

  /**
   * The last hole in "no bound can ever render green": the tone MAPS.
   *
   * Every test above asserts `data-tone`, deliberately — pinning Tailwind class
   * strings would make the suite fail on a palette tweak rather than on a logic
   * change. But that leaves `PILL_CLASS` / `ROW_EDGE` / `ROW_DOT` unguarded: set
   * their `unjudged` entry to the pass colour and an unbounded reading renders
   * green with every `data-tone` still reading "unjudged".
   *
   * So this asserts the one thing that is semantic rather than cosmetic:
   * `emerald` is this app's PASS colour and may never appear on a row nothing
   * is judging. A neutral repaint (slate-100 to slate-200) still passes;
   * painting it green does not.
   *
   * This works only because the edge bar carries a CLASS. It used to carry an
   * inline `#10b981`, which React serialises to `rgb(16, 185, 129)` — so the
   * bar could be painted the pass colour and this test could not see it. That
   * hole is why `ROW_EDGE` and `ROW_DOT` were collapsed into one class map;
   * mutation-checked, and it fails now where it did not before.
   */
  it('renders no pass-green anywhere on a row that nothing is judging', () => {
    renderCard({ slots: [tempSlot({ min: null, max: null }), humidSlot({ min: null, max: null })] });
    const row = screen.getByTestId('ts-row').outerHTML.toLowerCase();
    expect(row).not.toMatch(/emerald|green/);
  });

  it('judges a half-open band rather than greying it out', () => {
    renderCard({ slots: [tempSlot({ max: null }), humidSlot()] });
    expect(toneOf('temp')).toBe('in');
  });

  it('renders the timestamp through the injected administered formatter', () => {
    renderCard();
    expect(screen.getByTestId('ts-timestamp')).toHaveTextContent(`ADMIN-FMT<${TS}>`);
  });

  it('keeps a column for each extra telemetry key, and never paints it as a pass', () => {
    renderCard({
      rows: [{ ts: TS, values: { temp: 24.5, humidity: 51, co2: 415.25 }, errors: {} }],
      extraKeys: ['co2'],
    });
    expect(screen.getByRole('columnheader', { name: 'co2' })).toBeInTheDocument();
    // Rendered at the fallback precision it was given, and unjudged: no bound
    // is administered for a key nobody declared as a slot.
    expect(screen.getByTestId('ts-value-co2')).toHaveTextContent('415.25');
    expect(toneOf('co2')).toBe('unjudged');
  });

  it('renders the ADMINISTERED fault word for a reading that was not a number', () => {
    renderCard({
      rows: [{ ts: TS, values: { temp: null, humidity: 51 }, errors: { temp: true } }],
      failureWord: 'PROBE FAULT',
    });
    const cell = screen.getByTestId('ts-value-temp');
    expect(cell).toHaveTextContent('PROBE FAULT');
    expect(cell.getAttribute('data-tone')).toBe('fault');
    expect(screen.getByTestId('ts-row').getAttribute('data-tone')).toBe('fault');
  });

  it('shows an em dash, not a zero, for a key with no reading at that instant', () => {
    renderCard({ rows: [{ ts: TS, values: { temp: null, humidity: 51 }, errors: {} }] });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent('—');
  });

  it('renders each value at its OWN server-resolved precision', () => {
    renderCard({ rows: [{ ts: TS, values: { temp: 24.46, humidity: 51.4 }, errors: {} }] });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent('24.5 °C');
    expect(screen.getByTestId('ts-value-humidity')).toHaveTextContent('51 %RH');
  });

  /**
   * The band shows the LAST READING of the period, supplied by the page from
   * `latestValueForKey`. Deriving it from `rows[0]` would make it change when
   * the operator turns to page 2 of the same period.
   */
  it('shows the last reading the PAGE supplied, not the newest row on screen', () => {
    renderCard({
      slots: [tempSlot({ last: 23.1 }), humidSlot({ last: 47 })],
      rows: [{ ts: TS, values: { temp: 24.5, humidity: 51 }, errors: {} }],
    });
    const band = screen.getByTestId('ts-last-reading-band');
    expect(within(band).getByText('23.1')).toBeInTheDocument();
    expect(within(band).getByText('47')).toBeInTheDocument();
    expect(within(band).queryByText('24.5')).not.toBeInTheDocument();
  });

  it('keeps the existing empty state', () => {
    renderCard({ rows: [], totalItems: 0 });
    expect(screen.getByText('No readings in this window.')).toBeInTheDocument();
  });

  it('keeps the governed export reachable by its accessible name', () => {
    renderCard();
    expect(screen.getByRole('button', { name: 'Export as PDF' })).toBeInTheDocument();
  });

  /**
   * Constraint 6: the reference's "Last Reading" dropdown and funnel button
   * have no defined semantics and the page already carries a period and an
   * interval control. A second range control here would be two answers to one
   * question, so neither was built.
   */
  it('adds no second period selector and no filter control', () => {
    renderCard();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    // The export is the ONLY button in the card header.
    expect(screen.getByRole('button', { name: 'Export as PDF' })).toBeInTheDocument();
  });

  it('drops a slot the instrument does not report', () => {
    renderCard({ slots: [tempSlot(), humidSlot({ key: null })] });
    expect(screen.getByRole('columnheader', { name: 'Temperature (°C)' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Humidity (%RH)' })).not.toBeInTheDocument();
  });
});
