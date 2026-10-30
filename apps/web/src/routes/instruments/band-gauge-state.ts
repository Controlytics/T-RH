/**
 * Which state a band gauge is in — the ONE band rule, pure.
 *
 * Lifted out of `band-gauge.tsx` (2026-10-30) so the dashboard gauge widget
 * (`routes/dashboard/widgets/gauge-model.ts`) places a reading by the SAME
 * geometry without importing the trend page's card: that import put the whole
 * BandGauge component in the main bundle every login downloads. `band-gauge.tsx`
 * re-exports both names, so its importers are unchanged.
 */

export type BandGaugeState =
  /** No reading at all. NEVER a marker at zero: zero is a measurement. */
  | { kind: 'no-reading' }
  /**
   * There is a reading but no band to place it in. `assessed` says whether the
   * reading is still being judged — a half-open band (NMT/NLT) checks one side
   * and is a real administration, so its status word stays honest even though
   * no arc can be drawn.
   *
   * It carried a `note` explaining WHICH of the three cases this was until
   * 2026-08-31, when the operator asked for those lines off the card. The
   * distinction is not lost, it is just no longer narrated: the panel names the
   * bounds that survived, so one cell means one bound, none means none, and the
   * status word says whether anything is judging the reading.
   */
  | { kind: 'no-track'; assessed: boolean }
  /** A usable band: both bounds finite, high strictly above low. */
  | {
      kind: 'banded';
      min: number;
      max: number;
      /** 0–1, clamped — the arc's sweep from the low bound. */
      position: number;
      breach: 'low' | 'high' | null;
      /** reading − low. Negative on a low breach (that is the excess). */
      aboveLow: number;
      /** high − reading. Negative on a high breach. */
      belowHigh: number;
    };

export function finite(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/**
 * Which of the gauge's states this slot is in.
 *
 * Pure, and exported, because the four states named in the design brief plus
 * the three mis-administration cases the schema actually permits (one bound
 * only, low === high, low > high) are where this will break, and none of them
 * can be checked by looking at the rendered page from this dev environment.
 */
export function bandGaugeState(
  value: number | null | undefined,
  min: number | null | undefined,
  max: number | null | undefined,
  decimals: number,
): BandGaugeState {
  if (!finite(value)) return { kind: 'no-reading' };

  const hasMin = finite(min);
  const hasMax = finite(max);

  if (!hasMin && !hasMax) {
    return { kind: 'no-track', assessed: false };
  }
  if (!hasMin || !hasMax) {
    // One side is checked, so the status word below stays real; there is simply
    // no interval to sweep an arc across.
    return { kind: 'no-track', assessed: true };
  }
  if (max <= min) {
    // Reachable: both bounds are operator-typed instrument attributes. Dividing
    // by a zero-width band would put every reading at the same place, which is
    // indistinguishable from a broken gauge.
    return { kind: 'no-track', assessed: true };
  }

  const span = max - min;
  const raw = (value - min) / span;
  return {
    kind: 'banded',
    min,
    max,
    position: Math.min(1, Math.max(0, raw)),
    breach: value < min ? 'low' : value > max ? 'high' : null,
    aboveLow: value - min,
    belowHigh: max - value,
  };
}
