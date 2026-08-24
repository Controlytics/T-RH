import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BandGauge, bandGaugeState } from '../band-gauge';

/**
 * The band gauge is the one element on the trend page that says something no
 * number on it says: WHERE inside its allowed range this reading sits. Every
 * way it can be wrong is a way of asserting a band, a position or a judgement
 * that the record does not support — a marker at zero for a reading that never
 * arrived, an empty track implying limits nobody set, a position computed
 * against a NULL bound.
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
    expect(bandGaugeState(22.4, null, null, 1)).toEqual({
      kind: 'no-track', note: 'No limits set — not assessed', assessed: false,
    });
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
    const s = bandGaugeState(22.4, 18, null, 1);
    expect(s).toMatchObject({ kind: 'no-track', assessed: true });
    expect((s as any).note).toContain('NLT 18.0');
    expect(bandGaugeState(22.4, null, 27, 1)).toMatchObject({ kind: 'no-track', assessed: true });
  });

  it('a zero-width or inverted band draws no track', () => {
    expect(bandGaugeState(18, 18, 18, 1)).toMatchObject({ kind: 'no-track', assessed: true });
    expect(bandGaugeState(22, 27, 18, 1)).toMatchObject({ kind: 'no-track', assessed: true });
  });
});

describe('BandGauge render', () => {
  it('1 — inside its band: the marker is in position and both headrooms are stated', () => {
    renderGauge();
    const marker = screen.getByTestId('band-marker');
    expect(marker.getAttribute('data-breach')).toBe('none');
    // (22.4 − 18) / 9 = 48.89%
    expect(marker.style.getPropertyValue('--band-marker-left')).toBe('48.89%');
    expect(screen.getByText('4.4 above low')).toBeInTheDocument();
    expect(screen.getByText('4.6 below high')).toBeInTheDocument();
    // `statusClasses`' own word, never a second vocabulary invented here.
    expect(screen.getByTestId('band-status')).toHaveTextContent('In spec');
  });

  it('2 — outside its band: the marker is hard against the breached end and the excess is named', () => {
    renderGauge({ reading: at(31.5) });
    const marker = screen.getByTestId('band-marker');
    expect(marker.getAttribute('data-breach')).toBe('high');
    expect(marker.style.getPropertyValue('--band-marker-left')).toBe('100.00%');
    // Outside the track, not on its end.
    expect(marker.style.transform).toContain('50%');
    expect(screen.getByText('4.5 °C above the high limit')).toBeInTheDocument();
    expect(screen.getByTestId('band-status')).toHaveTextContent('Out of limit');
  });

  it('2b — a low breach reads as below the LOW limit, not as a headroom', () => {
    renderGauge({ reading: at(12) });
    expect(screen.getByTestId('band-marker').getAttribute('data-breach')).toBe('low');
    expect(screen.getByText('6.0 °C below the low limit')).toBeInTheDocument();
    expect(screen.queryByText(/above low/)).toBeNull();
  });

  it('3 — no limits set: no track at all, and the number is not judged', () => {
    renderGauge({ min: null, max: null, limitSource: null });
    expect(screen.queryByTestId('band-marker')).toBeNull();
    expect(screen.getByTestId('band-note')).toHaveTextContent('No limits set — not assessed');
    // NOT "In spec": nothing was checked, and a green word here would assert a
    // compliance that no administered limit supports.
    expect(screen.getByTestId('band-status')).toHaveTextContent('Not assessed');
    expect(screen.getByText('22.4')).toBeInTheDocument();
  });

  it('4 — no reading: said in words, with no marker anywhere on the page', () => {
    renderGauge({ reading: null });
    expect(screen.queryByTestId('band-marker')).toBeNull();
    expect(screen.getByTestId('band-status')).toHaveTextContent('No data');
    expect(screen.getByText(/No reading to place/)).toBeInTheDocument();
    // Never a 0 that reads as a measurement.
    expect(screen.queryByText('0.0')).toBeNull();
  });

  it('renders the reading at the instrument’s own resolved precision', () => {
    renderGauge({ reading: at(22.4), decimals: 0 });
    expect(screen.getByText('22')).toBeInTheDocument();
  });

  it('cannot be broken by a silly decimals attribute (toFixed would throw)', () => {
    expect(() => renderGauge({ decimals: 900 })).not.toThrow();
  });

  it('says where the limits came from — a set point with no source reads as asserted', () => {
    renderGauge({ limitSource: 'ROOM', roomCode: 'CR-01' });
    expect(screen.getByText('(from room CR-01)')).toBeInTheDocument();
  });

  it('holds the marker’s resting position in the style, not in the animation', () => {
    // The keyframe's `to` is this same value, so the reading's position is
    // correct with the animation absent, disabled or already finished.
    renderGauge();
    const marker = screen.getByTestId('band-marker');
    expect(marker.className).toContain('band-marker');
    expect(marker.style.left).toBe('var(--band-marker-left)');
  });
});
