/**
 * Dryer countdown + temperature-options hook — Phase 8.7 Wave-5 split.
 *
 * Both DryingFilterRow (desktop, in `routes/filter-management/filter-operations.tsx`)
 * and DryingFilterCard (mobile, in `routes/mobile/mobile-operations.tsx`)
 * render dryer-in-progress UI with:
 *   - a 1Hz now-tick driving the countdown
 *   - SWR-or-cache load of the cycle's `dryerStartedAt` + `dryerDurationMinutes`
 *   - equipment-group resolution (cycle-pinned → block-cached fallback)
 *   - temperature-instrument lookup + dropdown options computed via least-count
 *
 * The presentations differ:
 *   - desktop: minute-level granularity, simple row layout, persistent panel
 *   - mobile: minute:second countdown + progress bar, card layout
 *
 * This hook owns the data + derived state. Each page keeps its own JSX shell.
 *
 * NOTE: This hook does NOT subscribe to the `/api/filters/:id/current-state`
 * SWR endpoint — the caller does, when online. The hook accepts the loaded
 * cycle/equipment data via callbacks so the desktop SWR refresh + mobile
 * polled load patterns can both stay intact without forcing one into the
 * other's idiom.
 */

import { useEffect, useState } from 'react';

/**
 * Live now-tick at 1 Hz. Pauses on unmount automatically. Both pages
 * previously inlined the same `setInterval(setNow(Date.now()), 1000)`.
 */
export function useNowTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/**
 * Build temperature dropdown options from instrument operating-range +
 * least-count. Both desktop (`buildTempOptions`) and mobile (inline) had
 * essentially this loop. Differences:
 *   - desktop snaps the first value to a least-count multiple ≥ min
 *     (`Math.ceil(min / step) * step`)
 *   - mobile starts at min and walks by step
 *
 * Desktop's behaviour is the more careful one (avoids fractional-min drift
 * when the operator can only select multiples of leastCount). Adopting it
 * for both is consistent with the task's no-behavior-change rule for the
 * tablet because desktop and mobile both render through the same option list
 * which already gets clamped by the `<select>` value rules — but to honour
 * "byte-equivalent runtime", we keep BOTH flavours and let the caller pick.
 */
export function buildTempOptionsSnapped(min: number, max: number, step: number): number[] {
  if (!(step > 0) || max <= min) return [];
  const opts: number[] = [];
  const decimals = (String(step).split('.')[1] || '').length;
  const first = Math.ceil(min / step) * step;
  for (let v = first; v <= max + 1e-9; v += step) {
    opts.push(Number(v.toFixed(decimals)));
    if (opts.length > 500) break; // safety
  }
  return opts;
}

/**
 * Mobile flavour — starts at `min`, walks by `step`. Identical to the inline
 * loop in DryingFilterCard:
 *
 *   const step = leastCount > 0 ? leastCount : 1;
 *   for (let v = operatingMin; v <= operatingMax + 0.001;
 *        v = Math.round((v + step) * 100) / 100) { ... }
 *
 * Defaults `step` to 1 when leastCount <= 0 (matches the inline behaviour;
 * NOT byte-equivalent to the snapped flavour above which returns empty for
 * non-positive step). Kept as its own export so the byte-equivalent mobile
 * output is preserved.
 */
export function buildTempOptionsLinear(min: number, max: number, step: number): number[] {
  const opts: number[] = [];
  const effectiveStep = step > 0 ? step : 1;
  for (
    let v = min, i = 0;
    v <= max + 0.001 && i < 10000;
    v = Math.round((v + effectiveStep) * 100) / 100, i++
  ) {
    opts.push(v);
  }
  return opts;
}

/**
 * Find the dryer temperature instrument inside an equipment group's
 * `instruments[]`. Filters by `stageKey === 'DRY_IN'` AND a description
 * matching `/temp/i`. Both pages had this identical lookup.
 */
export function findDryerTempInstrument(equipGroup: any): any | null {
  return (
    (equipGroup?.instruments ?? []).find(
      (i: any) => i.stageKey === 'DRY_IN' && /temp/i.test(i.description ?? ''),
    ) ?? null
  );
}

/**
 * Derive the countdown projections from a cycle row + the current `now`.
 * Returns `null`-ish dates when the cycle hasn't started the dryer yet.
 *
 *   - `halfMs` = midpoint of the dryer cycle; both pages use this as the
 *     "ready for reading" gate (mirrors the server's `/advance` validation
 *     for the SUBMIT_READINGS sub-action).
 *   - `halfReached` is true once `now - startedAt >= halfMs`.
 *   - `remainingToHalfMin` is the rounded-up minutes until reading is allowed.
 *   - `remainingSec` (mobile) is the second-precision version.
 */
export interface DryerProjection {
  startedAt: number | null;
  durationMin: number | null;
  halfMs: number;
  totalMs: number;
  elapsedMs: number;
  halfReached: boolean;
  remainingToHalfMin: number;
  remainingSec: number;
  remainingMin: number;
  remainingSecPart: number;
  progressPct: number;
}

export function projectDryerCountdown(
  cycle: { dryerStartedAt?: string | Date | null; dryerDurationMinutes?: number | null } | null | undefined,
  now: number,
): DryerProjection {
  const startedAt = cycle?.dryerStartedAt ? new Date(cycle.dryerStartedAt).getTime() : null;
  const durationMin: number | null = cycle?.dryerDurationMinutes ?? null;
  const halfMs = (durationMin ?? 0) * 60_000 / 2;
  const totalMs = (durationMin ?? 0) * 60_000;
  const elapsedMs = startedAt ? now - startedAt : 0;
  const halfReached = startedAt !== null && elapsedMs >= halfMs;
  const remainingMs = Math.max(0, halfMs - elapsedMs);
  const remainingToHalfMin = Math.ceil(remainingMs / 60_000);
  const remainingSec = Math.max(0, Math.ceil(remainingMs / 1000));
  const remainingMin = Math.floor(remainingSec / 60);
  const remainingSecPart = remainingSec % 60;
  const progressPct = totalMs > 0 ? Math.min(100, (elapsedMs / totalMs) * 100) : 0;
  return {
    startedAt,
    durationMin,
    halfMs,
    totalMs,
    elapsedMs,
    halfReached,
    remainingToHalfMin,
    remainingSec,
    remainingMin,
    remainingSecPart,
    progressPct,
  };
}
