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

/**
 * First alias that any reading matches wins — NOT first reading that matches any
 * alias. A device sending both `temperature` and `temp` must resolve the same
 * way on every request, and only the alias order can guarantee that.
 */
export function resolveSlot<T extends { key: string }>(aliases: string[], readings: T[]): T | null {
  for (const alias of aliases) {
    const hit = readings.find((r) => r.key.toLowerCase() === alias);
    if (hit) return hit;
  }
  return null;
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
