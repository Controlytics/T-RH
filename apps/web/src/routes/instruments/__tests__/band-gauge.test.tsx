import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RS485_FAILURE_TEXT_DEFAULT, SENSOR_RANGE_TEXT_DEFAULT } from '@digilog/shared';
import { BandGauge, bandGaugeState, READING_SIZE } from '../band-gauge';

/**
 * The latest-value card is the one element on the trend page that says
 * something no number on it says: WHERE inside its allowed range this reading
 * sits. Every way it can be wrong is a way of asserting a band, a position or a
 * judgement that the record does not support — an arc at zero for a reading
 * that never arrived, a ring implying limits nobody set, a position computed
 * against a NULL bound, or a word this file invented rather than the one the
 * server administers.
 *
 * None of this can be checked by looking at the page from this dev environment
 * (the API's mkcert certificate keeps a headless browser from ever reaching
 * it), so the states are asserted here instead.
 */

const at = (value: number) => ({ value, ts: new Date().toISOString() });

function renderGauge(props: Partial<React.ComponentProps<typeof BandGauge>> = {}) {
  return render(
    <BandGauge
      label="Temperature"
      unit="°C"
      reading={at(22.4)}
      decimals={1}
      min={18}
      max={27}
      limitSource="INSTRUMENT"
      roomCode={null}
      accent="#2a78d6"
      {...props}
    />,
  );
}

describe('bandGaugeState', () => {
  it('1 — a reading inside its band is placed proportionally, with both headrooms', () => {
    const s = bandGaugeState(22.4, 18, 27, 1);
    expect(s.kind).toBe('banded');
    if (s.kind !== 'banded') return;
    expect(s.breach).toBeNull();
    expect(s.position).toBeCloseTo((22.4 - 18) / 9, 6);
    expect(s.aboveLow).toBeCloseTo(4.4, 6);
    expect(s.belowHigh).toBeCloseTo(4.6, 6);
  });

  it('the marker sits at the very ends when the reading is exactly on a bound', () => {
    expect((bandGaugeState(18, 18, 27, 1) as any).position).toBe(0);
    expect((bandGaugeState(27, 18, 27, 1) as any).position).toBe(1);
    // On the bound is IN limit — `outOfSpec` treats a bound as inclusive, and a
    // gauge calling it a breach would contradict the alarm beside it.
    expect((bandGaugeState(27, 18, 27, 1) as any).breach).toBeNull();
  });

  it('2 — a reading outside the band is clamped to the breached end and named as a breach', () => {
    const low = bandGaugeState(12, 18, 27, 1);
    expect(low).toMatchObject({ kind: 'banded', position: 0, breach: 'low' });
    const high = bandGaugeState(31.5, 18, 27, 1);
    expect(high).toMatchObject({ kind: 'banded', position: 1, breach: 'high' });
    // The headroom figures become the EXCESS, not a negative headroom to print.
    expect((high as any).belowHigh).toBeCloseTo(-4.5, 6);
  });

  it('3 — no limits at all collapses the gauge and is not assessed', () => {
    expect(bandGaugeState(22.4, null, null, 1)).toEqual({ kind: 'no-track', assessed: false });
  });

  it('4 — no reading is stated, never positioned', () => {
    expect(bandGaugeState(null, 18, 27, 1)).toEqual({ kind: 'no-reading' });
    expect(bandGaugeState(undefined, 18, 27, 1)).toEqual({ kind: 'no-reading' });
    // A non-finite reading is a BAD reading, not a reading at zero.
    expect(bandGaugeState(NaN, 18, 27, 1)).toEqual({ kind: 'no-reading' });
    expect(bandGaugeState(Infinity, 18, 27, 1)).toEqual({ kind: 'no-reading' });
  });

  /**
   * Both bounds are operator-typed instrument attributes, so all three of these
   * are reachable administrations. None of them has a denominator to divide by;
   * letting any of them fall through to the banded branch would put the marker
   * at NaN% or pin every reading to the same spot.
   */
  it('a half-open band draws no track but is still assessed on the side that exists', () => {
    // `assessed: true` is the load-bearing half: one side IS being checked, so
    // the status word stays a real judgement even with no arc to draw.
    expect(bandGaugeState(22.4, 18, null, 1)).toEqual({ kind: 'no-track', assessed: true });
    expect(bandGaugeState(22.4, null, 27, 1)).toEqual({ kind: 'no-track', assessed: true });
  });

  it('a zero-width or inverted band draws no track', () => {
    expect(bandGaugeState(18, 18, 18, 1)).toMatchObject({ kind: 'no-track', assessed: true });
    expect(bandGaugeState(22, 27, 18, 1)).toMatchObject({ kind: 'no-track', assessed: true });
  });
});

describe('BandGauge render', () => {
  it('1 — inside its band: the arc is swept to position and both bounds are named', () => {
    renderGauge();
    const arc = screen.getByTestId('band-arc');
    expect(arc.getAttribute('data-breach')).toBe('none');
    // (22.4 − 18) / 9 = 48.89% — the same worked number the horizontal track
    // was pinned on before the operator's card replaced it.
    expect(arc.getAttribute('data-position')).toBe('48.89');
    // The bounds are stated in full rather than left to be read off the arc.
    expect(screen.getByText('High limit')).toBeInTheDocument();
    expect(screen.getByText('Low limit')).toBeInTheDocument();
    expect(screen.getByText('27.0')).toBeInTheDocument();
    expect(screen.getByText('18.0')).toBeInTheDocument();
    // `statusClasses`' own word, never a second vocabulary invented here — and
    // the same word in both places the card prints it.
    expect(screen.getByTestId('band-status')).toHaveTextContent('In limit');
    expect(screen.getByTestId('band-status-word')).toHaveTextContent('In limit');
  });

  it('shows the reading with its unit, and the quantity it belongs to', () => {
    renderGauge();
    expect(screen.getByText('Temperature')).toBeInTheDocument();
    // Value and unit, and nothing else in the reading line.
    expect(screen.getByTestId('band-reading')).toHaveTextContent(/^22\.4°C$/);
  });

  /**
   * WHEN the reading arrived, as an instant — not "6d ago" (operator,
   * 2026-08-31). A relative age re-reads differently every time the page is
   * opened; the arrival time is a fixed fact about the record.
   *
   * The format, the clock and the TIMEZONE are all administered
   * (`/api/config/datetime/current`), so the card must render what the page's
   * `useDatetimeFormat` gives it. Asserting through a stub is what makes a
   * `toLocaleString()` in the component fail here.
   */
  it('prints the reading’s timestamp through the page’s administered formatter', () => {
    const ts = '2026-08-31T07:33:51.942Z';
    renderGauge({ reading: { value: 24.5, ts }, formatTs: (t) => `FORMATTED:${t}` });
    expect(screen.getByText(`FORMATTED:${ts}`)).toBeInTheDocument();
    expect(screen.queryByText(/ago$/)).toBeNull();
  });

  it('falls back to the stored instant, never to a format invented here', () => {
    const ts = '2026-08-31T07:33:51.942Z';
    renderGauge({ reading: { value: 24.5, ts } });
    expect(screen.getByText(ts)).toBeInTheDocument();
  });

  it('2 — outside its band: the arc is hard against the breached end and the excess is named', () => {
    renderGauge({ reading: at(31.5) });
    const arc = screen.getByTestId('band-arc');
    expect(arc.getAttribute('data-breach')).toBe('high');
    expect(arc.getAttribute('data-position')).toBe('100.00');
    expect(screen.getByText('4.5 °C above the high limit')).toBeInTheDocument();
    expect(screen.getByTestId('band-status')).toHaveTextContent('Out of limit');
    expect(screen.getByTestId('band-status-word')).toHaveTextContent('Out of limit');
  });

  it('2b — a low breach reads as below the LOW limit, and the arc has no sweep left', () => {
    renderGauge({ reading: at(12) });
    const arc = screen.getByTestId('band-arc');
    expect(arc.getAttribute('data-breach')).toBe('low');
    expect(arc.getAttribute('data-position')).toBe('0.00');
    expect(screen.getByText('6.0 °C below the low limit')).toBeInTheDocument();
    expect(screen.queryByText(/above the high limit/)).toBeNull();
  });

  it('3 — no limits set: no arc at all, and the number is not judged', () => {
    renderGauge({ min: null, max: null, limitSource: null });
    expect(screen.queryByTestId('band-arc')).toBeNull();
    // No caption explaining the missing band (operator, 2026-08-31) — the empty
    // panel and the status word already say it.
    expect(screen.queryByTestId('band-note')).toBeNull();
    // NOT "In limit": nothing was checked, and a green word here would assert a
    // compliance that no administered limit supports.
    expect(screen.getByTestId('band-status')).toHaveTextContent('Not assessed');
    expect(screen.getByTestId('band-status-word')).toHaveTextContent('Not assessed');
    expect(screen.getByText('22.4')).toBeInTheDocument();
    // A bound nobody set is not NAMED — never a dash, and never a 0 that would
    // read as an administration. (It was two "—" cells until 2026-08-31; the
    // panel now lists only the bounds actually in force.)
    expect(screen.queryByText('High limit')).toBeNull();
    expect(screen.queryByText('Low limit')).toBeNull();
    expect(screen.queryByText('—')).toBeNull();
  });

  it('4 — no reading: said in words, with no arc anywhere on the card', () => {
    renderGauge({ reading: null });
    expect(screen.queryByTestId('band-arc')).toBeNull();
    expect(screen.getByTestId('band-status')).toHaveTextContent('No data');
    // No caption at all — the value's dash and the sub-line already say it.
    expect(screen.queryByTestId('band-note')).toBeNull();
    // Never a 0 that reads as a measurement, and no unit either — a dash is not
    // a measurement in °C.
    expect(screen.queryByText('0.0')).toBeNull();
    expect(screen.getByTestId('band-reading')).toHaveTextContent(/^—$/);
  });

  /**
   * The header prints the instrument's SERVER-RESOLVED status a few rows above
   * this card. Staleness is decided server-side, against `expectedIntervalSec`,
   * and cannot be re-derived from a timestamp in the browser — so a card
   * computing its own word from the numbers alone would print "In limit" under a
   * header saying "Offline", about one instrument, on one screen.
   *
   * The operator's reference drew exactly that contradiction — a "Not reporting"/"Offline"
   * pill above a green "WITHIN LIMITS" panel — which is why this card resolves
   * ONE status and prints that same word in both places.
   *
   * This is the case that actually reaches an operator: a probe that stops
   * reporting is far more common than a mis-administered band.
   */
  it('never asserts "In limit" over a reading the server has already called stale', () => {
    renderGauge({ instrumentStatus: 'STALE' });
    expect(screen.getByTestId('band-status')).toHaveTextContent('Offline');
    expect(screen.getByTestId('band-status')).not.toHaveTextContent('In limit');
    expect(screen.getByTestId('band-status-word')).not.toHaveTextContent('In limit');
    // The arc is still drawn — where the last reading sat is still true.
    expect(screen.getByTestId('band-arc')).toBeInTheDocument();
  });

  it('but a breach still reads as a breach — the stored numbers decide that', () => {
    renderGauge({ reading: at(31.5), instrumentStatus: 'STALE' });
    expect(screen.getByTestId('band-status')).toHaveTextContent('Out of limit');
  });

  /**
   * `computeInstrumentStatus` judges BOTH slots together, so its `OUT_OF_SPEC`
   * means "one of them breached" — not "this one did". Inheriting it printed
   * "Out of limit" over a temperature that was inside its band.
   *
   * Reported live: CWH/RDU/001-00 read 24.5 °C against 18–27 while its humidity
   * (55 %RH) breached a `High Humidity Limit` of 0. The operator's question was
   * exactly right — that IS a normal value.
   *
   * The header a few rows above still prints the instrument-level word, so it
   * will read "Out of limit" while this card reads "In limit". Different
   * subjects, and that is why this narrowed rather than the header.
   */
  it('does not inherit a breach that belongs to the instrument’s OTHER slot', () => {
    renderGauge({ reading: at(24.5), min: 18, max: 27, instrumentStatus: 'OUT_OF_SPEC' });
    expect(screen.getByTestId('band-status')).toHaveTextContent('In limit');
    expect(screen.getByTestId('band-status-word')).toHaveTextContent('In limit');
    expect(screen.queryByText(/Out of limit/)).toBeNull();
  });

  /**
   * Same shape, one step subtler: PARTIAL means a slot with a limit has no
   * reading. If it were THIS slot, `no-reading` would have returned NO_DATA
   * before the fall-through ran — so a PARTIAL reaching here is always about
   * the other one.
   */
  it('does not inherit PARTIAL either — it is about the slot that is missing', () => {
    renderGauge({ instrumentStatus: 'PARTIAL' });
    expect(screen.getByTestId('band-status')).toHaveTextContent('In limit');
    expect(screen.queryByText(/Partial data/)).toBeNull();
  });

  it('renders the reading at the instrument’s own resolved precision', () => {
    renderGauge({ reading: at(22.4), decimals: 0 });
    expect(screen.getByText('22')).toBeInTheDocument();
    // The bounds follow the same resolved precision — a card showing "22" beside
    // "27.0" would be quoting two administrations of one instrument.
    expect(screen.getByText('27')).toBeInTheDocument();
    expect(screen.getByText('18')).toBeInTheDocument();
  });

  it('cannot be broken by a silly decimals attribute (toFixed would throw)', () => {
    expect(() => renderGauge({ decimals: 900 })).not.toThrow();
  });

  /**
   * The hero size is measured off the reference, whose number is four
   * characters wide. Two strings can be far wider and neither is under this
   * file's control: an operator-typed fault word, and a probe administered to
   * `clampDecimals`' ceiling of 10. At the hero size either one runs past the
   * card, and the alternatives — wrapping the line, or truncating — either
   * break the layout or clip digits off a §11 reading.
   */
  it('steps the reading down a size rather than overflowing the card', () => {
    const big = renderGauge().container.querySelector('[data-testid="band-reading"]')!;
    expect(big.className).toContain(READING_SIZE.big);
    expect(big.className).toContain('whitespace-nowrap');

    // 22.4 at the clamped ceiling of 10 decimals: "22.4000000000".
    renderGauge({ decimals: 900 });
    expect(screen.getAllByTestId('band-reading')[1].className).not.toContain(READING_SIZE.big);

    // An administered word nobody kept short.
    renderGauge({ reading: null, sensorError: true, sensorWords: { failure: 'SENSOR BUS FAULT', outOfRange: 'OL' } });
    expect(screen.getAllByTestId('band-reading')[2].className).not.toContain(READING_SIZE.big);
  });

  it('steps the bounds down together, so the two never read as different kinds of number', () => {
    // Same ceiling, in the third of a card each bound gets: "27.0000000000".
    renderGauge({ decimals: 900 });
    const hi = screen.getByText('27.0000000000');
    const lo = screen.getByText('18.0000000000');
    expect(hi.className).not.toContain('text-2xl');
    expect(hi.className).toBe(lo.className);
    expect(hi.className).toContain('whitespace-nowrap');
  });

  /**
   * The visible `Limits 18.0 - 27.0 (from room CR-01)` line was removed on
   * 2026-08-31 at the operator's request. A set point with no source still reads as
   * asserted, so the fact did not go away — it moved onto the panel as a
   * tooltip, which is exactly where `telemetry-table.tsx` already keeps it
   * ("the source is a tooltip, not a visible column").
   */
  it('says where the limits came from, on the panel that shows them', () => {
    renderGauge({ limitSource: 'ROOM', roomCode: 'CR-01' });
    expect(screen.queryByText(/\(from room CR-01\)/)).toBeNull();
    expect(screen.getByText('High limit').closest('div')!.parentElement)
      .toHaveAttribute('title', 'Limits 18.0 - 27.0 (from room CR-01)');
  });

  it('names the instrument as the source when the bounds are its own', () => {
    renderGauge();
    expect(screen.getByText('High limit').closest('div')!.parentElement)
      .toHaveAttribute('title', 'Limits 18.0 - 27.0 (from this instrument)');
  });

  it('holds the arc’s resting position in the style, not in the animation', () => {
    // The keyframe's `to` is this same value, so the reading's position is
    // correct with the animation absent, disabled or already finished.
    renderGauge();
    const arc = screen.getByTestId('band-arc');
    expect(arc.getAttribute('class')).toContain('band-arc');
    expect(arc.style.strokeDashoffset).toBe('var(--band-arc-offset)');
    // 2π×40 × (1 − 0.4889) — the resting offset, present without the keyframe.
    expect(arc.style.getPropertyValue('--band-arc-offset')).toBe('128.46');
    expect(arc.style.getPropertyValue('--band-arc-full')).toBe('251.33');
  });

  /**
   * A bound the instrument switches off (`Enable_Temp_NLT` = 0) arrives here as
   * a NULL — the SERVER withholds it, because the alarm evaluator will not raise
   * on it. So the card must not name it: a cell reading "—" gives a withheld
   * bound the same weight on screen as a live one, and the panel is the card's
   * statement of what this reading is judged against.
   *
   * `boundEnabled` never decides what is DRAWN — only what the card says about
   * the absence. Passing it while both bounds are present must change nothing.
   */
  describe('a bound the instrument does not enforce', () => {
    it('names only the bounds in force, and keeps Status in the middle', () => {
      renderGauge({ min: null });
      expect(screen.getByText('High limit')).toBeInTheDocument();
      expect(screen.queryByText('Low limit')).toBeNull();
      // Status is still there, and now sits between nothing and nothing.
      expect(screen.getByTestId('band-status-word')).toBeInTheDocument();
      const panel = screen.getByText('High limit').closest('div')!.parentElement!;
      expect(panel.style.gridTemplateColumns).toBe('repeat(2, minmax(0, 1fr))');
    });

    it('drops the other bound just as readily — NMT is the HIGH one', () => {
      renderGauge({ max: null });
      expect(screen.getByText('Low limit')).toBeInTheDocument();
      expect(screen.queryByText('High limit')).toBeNull();
    });

    it('leaves Status alone in the panel when neither bound is enforced', () => {
      renderGauge({ min: null, max: null, limitSource: null });
      expect(screen.queryByText('High limit')).toBeNull();
      expect(screen.queryByText('Low limit')).toBeNull();
      const panel = screen.getByTestId('band-status-word').closest('div')!.parentElement!;
      expect(panel.style.gridTemplateColumns).toBe('repeat(1, minmax(0, 1fr))');
    });


    /**
     * The distinction the removed caption used to narrate still holds; it is
     * shown rather than said. A bound nobody administered leaves the panel with
     * one cell and NO caption, while a bound switched off gets the one caption
     * that survives — because nothing else on the card can carry that.
     */
    it('says nothing at all when the bound was simply never administered', () => {
      renderGauge({ min: null });
      expect(screen.queryByTestId('band-note')).toBeNull();
      expect(screen.queryByText(/no band to draw/)).toBeNull();
      expect(screen.queryByText(/not a usable band/)).toBeNull();
      // The panel still shows which side survived — one cell, not two.
      expect(screen.getByText('High limit')).toBeInTheDocument();
      expect(screen.queryByText('Low limit')).toBeNull();
    });

    /**
     * The live shape behind the request: an instrument carrying 0 for BOTH
     * bounds. `max <= min` is not a usable band, so no arc is drawn — but the
     * card no longer says so in words.
     */
    it('draws no arc for a 0 - 0 band, and does not narrate it', () => {
      renderGauge({ min: 0, max: 0, decimals: 0 });
      expect(screen.queryByTestId('band-arc')).toBeNull();
      expect(screen.queryByTestId('band-note')).toBeNull();
      expect(screen.queryByText(/not a usable band/)).toBeNull();
      // Both bounds ARE administered, so both are still named.
      expect(screen.getAllByText('0')).toHaveLength(2);
    });

    it('changes nothing while both bounds are in force', () => {
      renderGauge({ });
      expect(screen.getByText('High limit')).toBeInTheDocument();
      expect(screen.getByText('Low limit')).toBeInTheDocument();
      expect(screen.getByTestId('band-arc')).toBeInTheDocument();
      expect(screen.queryByTestId('band-note')).toBeNull();
    });
  });

  /**
   * A failed or saturated probe leaves the numeric slot NULL, exactly as an
   * unwired instrument does. Without the server's two flags this card printed
   * "No readings in this instrument's history" over an instrument that was
   * talking — a false statement about a §11 record, and the same defect the
   * dashboard table's `sensorError` handling exists to prevent.
   *
   * The words are ADMINISTERED. Asserting against props the test supplies is
   * what makes a literal `'Error'` baked into the component fail here.
   */
  describe('a probe that is talking but not measuring', () => {
    const words = { failure: 'BUS FAULT', outOfRange: 'SATURATED' };

    it('shows the administered failure word where the number would go, with no unit', () => {
      renderGauge({ reading: null, sensorError: true, sensorWords: words });
      expect(screen.getByTestId('band-reading')).toHaveTextContent(/^BUS FAULT$/);
      expect(screen.getByText('Sensor did not report a number')).toBeInTheDocument();
      // NOT the unwired-instrument line — telling those two apart is the whole
      // point of the flag.
      expect(screen.queryByText(/No readings in this instrument/)).toBeNull();
      // Nor the empty-slot note, which says the opposite: something DID arrive.
      expect(screen.queryByText(/nothing has arrived for this slot/)).toBeNull();
    });

    it('shows the administered out-of-range word for a saturated probe', () => {
      renderGauge({ reading: null, rangeError: true, sensorWords: words });
      expect(screen.getByTestId('band-reading')).toHaveTextContent(/^SATURATED$/);
      expect(screen.getByText('Outside this sensor’s measurable range')).toBeInTheDocument();
    });

    it('range wins over failure — an out-of-range value IS a number', () => {
      renderGauge({ reading: null, sensorError: true, rangeError: true, sensorWords: words });
      expect(screen.getByTestId('band-reading')).toHaveTextContent(/^SATURATED$/);
    });

    it('falls back to the SHARED constants, never to a literal in this component', () => {
      renderGauge({ reading: null, sensorError: true });
      expect(screen.getByTestId('band-reading')).toHaveTextContent(RS485_FAILURE_TEXT_DEFAULT);
      renderGauge({ reading: null, rangeError: true });
      expect(screen.getAllByTestId('band-reading')[1]).toHaveTextContent(SENSOR_RANGE_TEXT_DEFAULT);
    });
  });
});
