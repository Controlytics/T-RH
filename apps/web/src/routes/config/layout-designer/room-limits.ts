import type { RemarkChange } from '@/routes/instruments/remark-dialog';
import type { DesignerRoom } from './types';
import type { RoomForm } from './properties-panel';

/**
 * Which of a room's four limits the form moves off the STORED row.
 *
 * The server refuses a limit change without a `reason` (audit 2026-10-03,
 * DATA-11: a room's limits are a quality specification, and a change to one is
 * recorded with the operator's statement, the way an instrument attribute is).
 * This is the browser's copy of that one rule — `limitsChanged()` in the API's
 * floorplans routes — so the designer can ask for the reason BEFORE the
 * request instead of surfacing a 400. It must stay the same comparison: a
 * blank field is `null`, and `null` against `null` is no change, so re-saving
 * a room's label never asks for a remark. Returns the changed lines labelled
 * for the remark dialog; empty = nothing to sign for.
 */
const LIMIT_FIELDS = [
  ['tempMin', 'Min temperature (°C)'],
  ['tempMax', 'Max temperature (°C)'],
  ['rhMin', 'Min humidity (%RH)'],
  ['rhMax', 'Max humidity (%RH)'],
] as const;

export function numOrNull(s: string): number | null {
  const t = s.trim();
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

const show = (v: number | null) => (v == null ? '' : String(v));

export function limitChanges(
  room: Pick<DesignerRoom, 'tempMin' | 'tempMax' | 'rhMin' | 'rhMax'>,
  form: Pick<RoomForm, 'tempMin' | 'tempMax' | 'rhMin' | 'rhMax'>,
): RemarkChange[] {
  const out: RemarkChange[] = [];
  for (const [key, label] of LIMIT_FIELDS) {
    const before = room[key] ?? null;
    const next = numOrNull(form[key]);
    if (before !== next) out.push({ label, from: show(before), to: show(next) });
  }
  return out;
}
