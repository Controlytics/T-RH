/**
 * The vocabulary that turns free-form telemetry keys into two named slots, and
 * a reading plus a room's limits into one status.
 *
 * Lives in @digilog/shared because BOTH sides need it and they must agree: the
 * API computes each instrument's status, the web app maps that status to a
 * colour and aggregates rooms. Two implementations would drift, and the drift
 * would show up as a room whose colour contradicts its own rows.
 *
 * Ingest stores whatever key a device sends (`instruments/payload-parser.ts`
 * imposes no vocabulary). Live data here uses `temperature` / `humidity`; the
 * e2e suite exercises `temp` / `rh`. Neither is more correct, so the mapping is
 * administered rather than hardcoded — see `config/defs/telemetry-slots.def.ts`.
 *
 * Design: docs/superpowers/specs/2026-08-11-instrument-dashboard-floorplan-design.md
 */

export type TelemetrySlot = 'temperature' | 'humidity';

export const TELEMETRY_SLOTS: readonly TelemetrySlot[] = ['temperature', 'humidity'] as const;

/**
 * Newline-separated, most-preferred first — the same wire format as instrument
 * attribute keys, so an admin editing either is writing a list of words and
 * never JSON punctuation.
 */
export const TELEMETRY_SLOT_ALIASES_DEFAULT: Record<TelemetrySlot, string> = {
  temperature: 'temperature\ntemp\nt',
  humidity: 'humidity\nrh\nhum',
};

/** Trim, lowercase, drop blanks, de-duplicate keeping FIRST (order is precedence). */
export function parseTelemetryAliases(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const v = line.trim().toLowerCase();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** A reading's instant in ms; no or unreadable timestamp = never newer than anything. */
function instantOf(ts: Date | string | number | null | undefined): number {
  if (ts === null || ts === undefined) return Number.NEGATIVE_INFINITY;
  const ms = ts instanceof Date ? ts.getTime() : typeof ts === 'number' ? ts : Date.parse(ts);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Which of an instrument's readings is the slot's reading: among the readings
 * whose key is ANY of the aliases, the NEWEST wins; readings at the same instant
 * (one message carrying both `temperature` and `temp`) — or with no timestamp —
 * fall back to alias order, so the answer is the same on every request.
 *
 * Audit 2026-11-07, S8-1: this used to be alias order alone. The latest table
 * keeps every key a device ever sent, so a device that once sent `temperature`
 * and now sends `t` resolved to the frozen `temperature` row for good — the
 * dashboard showed it, and the alarm evaluator never saw the live breaching `t`.
 *
 * "Newest" is the stored `ts` — the DEVICE's stamp. A device whose clock runs
 * behind keeps the old key winning until its new key's stamps pass the old row's
 * (see `docs/feature-notes.md`, the S8-1 sentence under WIDGET DATA KEYS).
 */
export function resolveSlot<T extends { key: string; ts?: Date | string | number | null }>(
  aliases: string[],
  readings: T[],
): T | null {
  let best: T | null = null;
  let bestRank = Number.POSITIVE_INFINITY;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const r of readings) {
    const rank = aliases.indexOf(r.key.toLowerCase());
    if (rank < 0) continue;
    const at = instantOf(r.ts);
    if (best === null || at > bestAt || (at === bestAt && rank < bestRank)) {
      best = r;
      bestRank = rank;
      bestAt = at;
    }
  }
  return best;
}

export type InstrumentStatus = 'OUT_OF_SPEC' | 'STALE' | 'NO_DATA' | 'PARTIAL' | 'OK';

/** Lower is worse. Also the precedence order in computeInstrumentStatus. */
export const STATUS_RANK: Record<InstrumentStatus, number> = {
  OUT_OF_SPEC: 1,
  STALE: 2,
  NO_DATA: 3,
  PARTIAL: 4,
  OK: 5,
};

export interface RoomLimits {
  tempMin: number | null;
  tempMax: number | null;
  rhMin: number | null;
  rhMax: number | null;
}

function breaches(value: number | null, min: number | null, max: number | null): boolean {
  if (value === null) return false;
  if (min !== null && value < min) return true;
  if (max !== null && value > max) return true;
  return false;
}

/** A slot is "promised" when its room sets either bound for it. */
function promised(min: number | null, max: number | null): boolean {
  return min !== null || max !== null;
}

export function computeInstrumentStatus(input: {
  temperature: number | null;
  humidity: number | null;
  limits: RoomLimits | null;
  reporting: boolean;
}): InstrumentStatus {
  const { temperature, humidity, limits, reporting } = input;
  const l = limits ?? { tempMin: null, tempMax: null, rhMin: null, rhMax: null };

  // 1. A breach outranks staleness on purpose: a probe last seen four hours ago
  //    reading 27 °C in a 25 °C room is a breach that happens to also be stale,
  //    and amber would understate it. Age is shown alongside regardless.
  if (breaches(temperature, l.tempMin, l.tempMax) || breaches(humidity, l.rhMin, l.rhMax)) {
    return 'OUT_OF_SPEC';
  }

  // 2. Not reporting. Judged by the instrument's own expectedIntervalSec where
  //    set, else the `instrument-activity` config window — the caller decides
  //    and passes the verdict in. There is exactly one staleness rule in this
  //    system and this is not the place that defines it.
  if (!reporting) return 'STALE';

  // 3. Reporting, but nothing has ever arrived.
  if (temperature === null && humidity === null) return 'NO_DATA';

  // 4. A slot the room sets a limit for has no reading — neither healthy nor a
  //    breach. Common: a temperature-only probe in a room that also specifies RH.
  if ((temperature === null && promised(l.tempMin, l.tempMax)) ||
      (humidity === null && promised(l.rhMin, l.rhMax))) {
    return 'PARTIAL';
  }

  return 'OK';
}

/** Worst status in a set — how a room takes its colour from its instruments. */
export function worstStatus(statuses: InstrumentStatus[]): InstrumentStatus {
  if (statuses.length === 0) return 'NO_DATA';
  return statuses.reduce((worst, s) => (STATUS_RANK[s] < STATUS_RANK[worst] ? s : worst));
}
