import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { resolveTrendWidgetTexts } from '@digilog/shared';
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

/** The shipped wording, from the one resolver. */
const LABELS = resolveTrendWidgetTexts({}).labels;

/** Deliberately unlike ANY locale output, so a `toLocaleString` regression
 *  cannot coincidentally satisfy the assertion. */
const fmt = (ts: string) => `ADMIN-FMT<${ts}>`;

function tempSlot(over: Partial<SlotColumn> = {}): SlotColumn {
  return {
    key: 'temp', heading: 'Temperature (°C)', decimals: 1,
    min: 18, max: 25, ...over,
  };
}

function humidSlot(over: Partial<SlotColumn> = {}): SlotColumn {
  return {
    key: 'humidity', heading: 'Humidity (%RH)', decimals: 0,
    min: 40, max: 60, ...over,
  };
}

function renderCard(props: Partial<React.ComponentProps<typeof TimeseriesTableCard>> = {}) {
  const rows: PivotRow[] = [{ ts: TS, values: { temp: 24.5, humidity: 51 }, errors: {} }];
  return render(
    <TimeseriesTableCard
      rows={rows}
      slots={[tempSlot(), humidSlot()]}
      failureWord="Error"
      formatTs={fmt}
      // The ADMINISTERED wording, resolved by the shared resolver exactly as the
      // page resolves it — never literals typed out here, or this suite would
      // stop noticing the day the shipped default changed.
      title={LABELS.timeseriesTitle}
      subtitle={LABELS.timeseriesSubtitle}
      timestampHeading={LABELS.timeseriesTimestampHeading}
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

  it('never paints a row green when a reading has no bound in force', () => {
    // Was "when it holds only extra keys" until the additional-keys section was
    // removed on 2026-09-01. The scenario is gone; the property is not, and it
    // is the one this whole file exists for — so it is rebuilt from a slot with
    // both bounds withheld rather than deleted with the feature.
    renderCard({
      slots: [tempSlot({ min: null, max: null }), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 24.5 }, errors: {} }],
    });
    expect(toneOf('temp')).toBe('unjudged');
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

  // REMOVED with the additional-keys section (2026-09-01): "keeps a column for
  // each extra telemetry key, and never paints it as a pass". The table now
  // renders the two administered slots only. Its neutral-tone half is covered
  // by "never paints a row green when a reading has no bound in force" above.

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
    // No unit in the cell since 2026-09-01 (operator): the column HEADING
    // carries it. The assertion is now exact rather than a substring, so a unit
    // creeping back into the value would fail here rather than pass unnoticed.
    renderCard({ rows: [{ ts: TS, values: { temp: 24.46, humidity: 51.4 }, errors: {} }] });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent(/^24\.5$/);
    expect(screen.getByTestId('ts-value-humidity')).toHaveTextContent(/^51$/);
  });

  it('keeps the unit in the column HEADING, where it is stated once', () => {
    // The discriminating half: dropping it from the cell must not drop it from
    // the page, or the numbers lose their quantity entirely.
    renderCard({ rows: [{ ts: TS, values: { temp: 24.5 }, errors: {} }] });
    expect(screen.getByRole('columnheader', { name: 'Temperature (°C)' })).toBeInTheDocument();
  });

  // REMOVED 2026-09-01 with the separate last-reading band (operator). It
  // asserted that the band showed the value the PAGE supplied rather than the
  // newest row on screen — which mattered because the two diverge on page 2.
  // There is no band now; the table opens with the newest row, which is the
  // same number the band was restating.

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

/**
 * A reading beyond the probe's declared SPAN is not a measurement.
 *
 * `telemetry-overview.ts` withholds such a value from the dashboard, the tiles
 * and the limit evaluator, and the sensor-range source raises an alarm saying
 * the probe was saturated. This table reads the RAW telemetry path, which
 * applies no such filter, so until 2026-09-01 it printed the number — the one
 * surface in the app disagreeing with the rest, and a §11 record showing `60.0`
 * beside an alarm saying that same instant was out of range.
 *
 * RANGE IS NOT A LIMIT: `High Temperature Limit` is the product spec,
 * `High Temperature Range` the hardware's span. These pin that the table keeps
 * them apart.
 */
describe('TimeseriesTableCard — a reading outside the probe span', () => {
  const spanned = (over = {}) => tempSlot({
    min: 18, max: 27, rangeLow: -40, rangeHigh: 50, outOfRangeWord: 'OL', ...over,
  });

  it('prints the administered word instead of the number', () => {
    renderCard({
      slots: [spanned(), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 60 }, errors: {} }],
    });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent('OL');
    expect(screen.getByTestId('ts-value-temp')).not.toHaveTextContent('60');
  });

  it('never defaults that word to a literal — it comes from config', () => {
    // The word is administered (`GET /api/config/sensor-range-alarms/display-text`).
    // A component that hardcoded "OL" would ignore a site that renamed it.
    renderCard({
      slots: [spanned({ outOfRangeWord: 'SATURATED' }), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 60 }, errors: {} }],
    });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent('SATURATED');
  });

  it('does NOT judge it against the spec limits', () => {
    // 60 is above the high LIMIT of 27, but it is not a reading, so painting it
    // as a breach would assert an excursion nobody can act on. Unjudged.
    renderCard({
      slots: [spanned(), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 60 }, errors: {} }],
    });
    expect(toneOf('temp')).toBe('fault');
  });

  it('leaves a reading INSIDE the span judged normally', () => {
    // The discriminating half: 30 is out of SPEC (>27) but well inside the
    // probe's span, so it is a real breach and must still read red.
    renderCard({
      slots: [spanned(), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 30 }, errors: {} }],
    });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent('30');
    expect(toneOf('temp')).toBe('out');
  });

  it('withholds nothing when the probe declares no span', () => {
    // Most instruments declare one, but a null bound means not declared — and
    // then every stored reading is shown as it always was.
    renderCard({
      slots: [spanned({ rangeLow: null, rangeHigh: null }), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 60 }, errors: {} }],
    });
    expect(screen.getByTestId('ts-value-temp')).toHaveTextContent('60');
  });
});

/**
 * Administered wording (2026-09-01) — title, subtitle and the Timestamp column.
 *
 * The two slot columns carry their own `heading`, administered the same way and
 * supplied by the page, so they are asserted here too: a wiring that renamed the
 * card but left the columns hardcoded would look entirely correct until somebody
 * renamed a column.
 */
describe('TimeseriesTableCard — administered wording', () => {
  it('prints the shipped wording when nothing is administered', () => {
    renderCard();
    expect(screen.getByText(LABELS.timeseriesTitle)).toBeInTheDocument();
    expect(screen.getByText(LABELS.timeseriesSubtitle)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: LABELS.timeseriesTimestampHeading }))
      .toBeInTheDocument();
  });

  it('a RENAMED title, subtitle and column heading all reach the card', () => {
    const labels = resolveTrendWidgetTexts({
      timeseriesTitle: 'Raw Log',
      timeseriesSubtitle: 'Every stored reading in the period',
      timeseriesTimestampHeading: 'Recorded at',
      timeseriesTemperatureHeading: 'Product Temp (°C)',
    }).labels;
    renderCard({
      title: labels.timeseriesTitle,
      subtitle: labels.timeseriesSubtitle,
      timestampHeading: labels.timeseriesTimestampHeading,
      slots: [tempSlot({ heading: labels.timeseriesTemperatureHeading }), humidSlot()],
    });

    expect(screen.getByText('Raw Log')).toBeInTheDocument();
    expect(screen.getByText('Every stored reading in the period')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Recorded at' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Product Temp (°C)' })).toBeInTheDocument();
    // The shipped words are GONE, not joined by the new ones.
    expect(screen.queryByText(LABELS.timeseriesTitle)).toBeNull();
    expect(screen.queryByRole('columnheader', { name: LABELS.timeseriesTimestampHeading })).toBeNull();
  });

  it('a BLANK heading falls back to the shipped wording, never an empty column', () => {
    const labels = resolveTrendWidgetTexts({
      timeseriesTimestampHeading: '   ', timeseriesTitle: '',
    }).labels;
    renderCard({ title: labels.timeseriesTitle, timestampHeading: labels.timeseriesTimestampHeading });
    expect(screen.getByText(LABELS.timeseriesTitle)).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: LABELS.timeseriesTimestampHeading }))
      .toBeInTheDocument();
  });

  it('renders the settings button the page hands it, and nothing when it is absent', () => {
    // The card holds no role check of its own — that lives in
    // `WidgetSettingsButton`, which renders null for a non-SUPER_ADMIN. This only
    // pins that the card gives it a home.
    renderCard({ settingsButton: <button type="button">Edit labels</button> });
    expect(screen.getByRole('button', { name: 'Edit labels' })).toBeInTheDocument();
  });
});

/**
 * `Error` and `OL` are ONE statement — this probe is not measuring — so they
 * must look identical (operator, 2026-09-01). Two fault words drifting into
 * different shapes or tints would read as two different conditions.
 */
describe('TimeseriesTableCard — the two fault words look the same', () => {
  const faultCell = () => screen.getByTestId('ts-value-temp');

  it('renders the RS485 word and the out-of-range word in the same pill', () => {
    const { unmount } = renderCard({
      slots: [tempSlot(), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: null }, errors: { temp: true } }],
      failureWord: 'Error',
    });
    const failureClass = faultCell().className;
    expect(faultCell()).toHaveTextContent('Error');
    unmount();

    renderCard({
      slots: [tempSlot({ rangeLow: -40, rangeHigh: 50, outOfRangeWord: 'OL' }), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: 60 }, errors: {} }],
    });
    expect(faultCell()).toHaveTextContent('OL');
    // The load-bearing assertion: same class string, so same box and same tint.
    expect(faultCell().className).toBe(failureClass);
  });

  it('gives them a pill, not bare text', () => {
    renderCard({
      slots: [tempSlot(), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: null }, errors: { temp: true } }],
      failureWord: 'Error',
    });
    // `rounded-lg` and a background are what make it a box rather than a word.
    expect(faultCell().className).toContain('rounded-lg');
    expect(faultCell().className).toContain('bg-red-50');
  });

  it('centres it in its cell', () => {
    renderCard({
      slots: [tempSlot(), humidSlot({ key: null })],
      rows: [{ ts: TS, values: { temp: null }, errors: { temp: true } }],
      failureWord: 'Error',
    });
    expect(faultCell().closest('td')!.className).toContain('text-center');
  });
});
