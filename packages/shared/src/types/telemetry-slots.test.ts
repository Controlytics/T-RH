import { describe, it, expect } from 'vitest';
import {
  parseTelemetryAliases,
  resolveSlot,
  computeInstrumentStatus,
  worstStatus,
  STATUS_RANK,
  TELEMETRY_SLOT_ALIASES_DEFAULT,
  type InstrumentStatus,
  type RoomLimits,
} from './telemetry-slots.js';

const noLimits: RoomLimits = { tempMin: null, tempMax: null, rhMin: null, rhMax: null };
const tempOnly: RoomLimits = { tempMin: 18, tempMax: 25, rhMin: null, rhMax: null };
const bothLimits: RoomLimits = { tempMin: 18, tempMax: 25, rhMin: 40, rhMax: 60 };

describe('parseTelemetryAliases', () => {
  it('splits on newlines, trims, drops blanks', () => {
    expect(parseTelemetryAliases('temperature\n  temp \n\n t \n')).toEqual(['temperature', 'temp', 't']);
  });

  it('lowercases so device casing does not matter', () => {
    expect(parseTelemetryAliases('Temperature\nTEMP')).toEqual(['temperature', 'temp']);
  });

  it('de-duplicates, keeping first occurrence for precedence', () => {
    expect(parseTelemetryAliases('temp\ntemperature\ntemp')).toEqual(['temp', 'temperature']);
  });

  it('returns [] for null, undefined and empty', () => {
    expect(parseTelemetryAliases(null)).toEqual([]);
    expect(parseTelemetryAliases(undefined)).toEqual([]);
    expect(parseTelemetryAliases('   ')).toEqual([]);
  });

  it('ships defaults that parse to the expected lists', () => {
    expect(parseTelemetryAliases(TELEMETRY_SLOT_ALIASES_DEFAULT.temperature))
      .toEqual(['temperature', 'temp', 't']);
    expect(parseTelemetryAliases(TELEMETRY_SLOT_ALIASES_DEFAULT.humidity))
      .toEqual(['humidity', 'rh', 'hum']);
  });
});

describe('resolveSlot', () => {
  const aliases = ['temperature', 'temp', 't'];

  it('returns the reading whose key matches', () => {
    expect(resolveSlot(aliases, [{ key: 'temp' }])).toEqual({ key: 'temp' });
  });

  it('matches case-insensitively', () => {
    expect(resolveSlot(aliases, [{ key: 'Temp' }])).toEqual({ key: 'Temp' });
  });

  it('prefers the earlier alias when a device sends both', () => {
    // Deterministic precedence is the whole point of an ordered list.
    const readings = [{ key: 'temp' }, { key: 'temperature' }];
    expect(resolveSlot(aliases, readings)).toEqual({ key: 'temperature' });
  });

  it('returns null when nothing matches', () => {
    expect(resolveSlot(aliases, [{ key: 'pressure' }])).toBeNull();
  });

  it('returns null for an empty alias list rather than guessing', () => {
    expect(resolveSlot([], [{ key: 'temp' }])).toBeNull();
  });

  // Audit 2026-11-07, S8-1: the latest table keeps EVERY key ever sent. A device
  // that once sent `temperature` and now sends `t` resolved to the frozen
  // `temperature` reading for good — its live breaching readings never alarmed.
  it('takes the NEWEST reading among the aliases, not the first alias ever stored', () => {
    const readings = [
      { key: 'temperature', ts: '2026-11-16T08:00:00Z' },
      { key: 't', ts: '2026-11-16T11:00:00Z' },
    ];
    expect(resolveSlot(aliases, readings)?.key).toBe('t');
  });

  it('compares Date and epoch timestamps as instants', () => {
    const readings = [
      { key: 'temp', ts: new Date('2026-11-16T11:00:00Z') },
      { key: 'temperature', ts: Date.parse('2026-11-16T08:00:00Z') },
    ];
    expect(resolveSlot(aliases, readings)?.key).toBe('temp');
  });

  it('falls back to alias order when two aliases arrived at the same instant', () => {
    // One message carrying both keys must resolve the same way on every request.
    const readings = [
      { key: 't', ts: '2026-11-16T11:00:00Z' },
      { key: 'temperature', ts: '2026-11-16T11:00:00.000Z' },
    ];
    expect(resolveSlot(aliases, readings)?.key).toBe('temperature');
  });

  it('a reading with no timestamp never beats one that has one', () => {
    const readings = [{ key: 'temperature' }, { key: 't', ts: '2026-11-16T11:00:00Z' }];
    expect(resolveSlot(aliases, readings)?.key).toBe('t');
  });
});

describe('computeInstrumentStatus', () => {
  it('is OK when reporting and within both limits', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: 50, limits: bothLimits, reporting: true }))
      .toBe('OK');
  });

  it('is OUT_OF_SPEC above max', () => {
    expect(computeInstrumentStatus({ temperature: 27, humidity: 50, limits: bothLimits, reporting: true }))
      .toBe('OUT_OF_SPEC');
  });

  it('is OUT_OF_SPEC below min', () => {
    expect(computeInstrumentStatus({ temperature: 17, humidity: 50, limits: bothLimits, reporting: true }))
      .toBe('OUT_OF_SPEC');
  });

  it('treats a limit boundary as in spec', () => {
    expect(computeInstrumentStatus({ temperature: 25, humidity: 60, limits: bothLimits, reporting: true }))
      .toBe('OK');
  });

  it('breaches on humidity alone', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: 65, limits: bothLimits, reporting: true }))
      .toBe('OUT_OF_SPEC');
  });

  it('ranks OUT_OF_SPEC above STALE — a stale breach is still a breach', () => {
    expect(computeInstrumentStatus({ temperature: 27, humidity: 50, limits: bothLimits, reporting: false }))
      .toBe('OUT_OF_SPEC');
  });

  it('is STALE when not reporting and not breaching', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: 50, limits: bothLimits, reporting: false }))
      .toBe('STALE');
  });

  it('is STALE rather than NO_DATA when it has never reported and is not reporting', () => {
    expect(computeInstrumentStatus({ temperature: null, humidity: null, limits: bothLimits, reporting: false }))
      .toBe('STALE');
  });

  it('is NO_DATA when reporting but no readings at all', () => {
    expect(computeInstrumentStatus({ temperature: null, humidity: null, limits: bothLimits, reporting: true }))
      .toBe('NO_DATA');
  });

  it('is PARTIAL when a limited slot has no reading', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: null, limits: bothLimits, reporting: true }))
      .toBe('PARTIAL');
  });

  it('is OK when the missing slot has no limit — nothing was promised', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: null, limits: tempOnly, reporting: true }))
      .toBe('OK');
  });

  it('is OK with no room at all, as long as it is reporting something', () => {
    expect(computeInstrumentStatus({ temperature: 22, humidity: null, limits: null, reporting: true }))
      .toBe('OK');
    expect(computeInstrumentStatus({ temperature: 999, humidity: null, limits: noLimits, reporting: true }))
      .toBe('OK');
  });
});

describe('worstStatus', () => {
  it('picks the lowest rank', () => {
    expect(worstStatus(['OK', 'STALE', 'OUT_OF_SPEC'])).toBe('OUT_OF_SPEC');
    expect(worstStatus(['OK', 'PARTIAL'])).toBe('PARTIAL');
  });

  it('returns NO_DATA for an empty list — a room with no instruments knows nothing', () => {
    expect(worstStatus([])).toBe('NO_DATA');
  });

  it('ranks every status distinctly, so "worst" is never ambiguous', () => {
    const ranks = Object.values(STATUS_RANK);
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it('orders exactly as the spec precedence table', () => {
    const ordered = (['OUT_OF_SPEC', 'STALE', 'NO_DATA', 'PARTIAL', 'OK'] as InstrumentStatus[])
      .map((s) => STATUS_RANK[s]);
    expect(ordered).toEqual([...ordered].sort((a, b) => a - b));
  });
});
