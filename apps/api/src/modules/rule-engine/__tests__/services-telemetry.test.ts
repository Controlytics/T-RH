import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * `services.telemetry.write`'s TIMESTAMP WINDOW (ruling TS-1, 2026-11-05; review B
 * I-4): ingest's plausibility window — the same constants and comparisons as
 * `parseDeviceTs` — but a rule write REFUSES (`TIMESTAMP_OUT_OF_WINDOW`, naming the
 * instant) where ingest replaces the stamp with arrival time. Judged before anything
 * is read or written: no database here, and the instrument lookup must never run.
 */
const { createRuleServices, timestampOutOfWindow } = await import('../services.js');
const { RULE_ENGINE_CONFIG_DEFAULTS } = await import('../config.js');
const { DEVICE_TS_MAX_AHEAD_MS, DEVICE_TS_MIN, parseDeviceTs } = await import('../../instruments/payload-parser.js');
const { prisma } = await import('../../../lib/prisma.js');

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const services = () => createRuleServices({ config: () => ({ ...RULE_ENGINE_CONFIG_DEFAULTS }), inc: () => undefined });

afterEach(() => { vi.restoreAllMocks(); });

describe('timestampOutOfWindow', () => {
  it('ingest\'s bounds, ingest\'s comparisons: exactly 10 minutes ahead and exactly 2000-01-01 are IN; one millisecond past either is OUT', () => {
    expect(timestampOutOfWindow(new Date(NOW + DEVICE_TS_MAX_AHEAD_MS), NOW)).toBeNull();
    expect(timestampOutOfWindow(new Date(DEVICE_TS_MIN.getTime()), NOW)).toBeNull();
    expect(timestampOutOfWindow(new Date(NOW - 30 * 86_400_000), NOW), 'a backdated instant inside the window is stored').toBeNull();
    expect(timestampOutOfWindow(new Date(NOW + DEVICE_TS_MAX_AHEAD_MS + 1), NOW)).toMatch(/^TIMESTAMP_OUT_OF_WINDOW/);
    expect(timestampOutOfWindow(new Date(DEVICE_TS_MIN.getTime() - 1), NOW)).toMatch(/^TIMESTAMP_OUT_OF_WINDOW/);
    // The same instants through ingest's own judge: kept / replaced at exactly the same edges.
    const at = new Date(NOW);
    expect(parseDeviceTs(NOW + DEVICE_TS_MAX_AHEAD_MS, at)).not.toBeNull();
    expect(parseDeviceTs(NOW + DEVICE_TS_MAX_AHEAD_MS + 1, at)).toBeNull();
    expect(parseDeviceTs(DEVICE_TS_MIN.getTime(), at)).not.toBeNull();
    expect(parseDeviceTs(DEVICE_TS_MIN.getTime() - 1, at)).toBeNull();
  });

  it('names the instant (and the server time when ahead); an invalid instant is refused too', () => {
    expect(timestampOutOfWindow(new Date('2099-01-01T00:00:00.000Z'), NOW))
      .toBe('TIMESTAMP_OUT_OF_WINDOW: 2099-01-01T00:00:00.000Z is more than 10 minutes ahead of the server\'s time (2026-11-05T10:00:00.000Z); nothing was stored');
    expect(timestampOutOfWindow(new Date('1999-12-31T23:59:59.999Z'), NOW))
      .toBe('TIMESTAMP_OUT_OF_WINDOW: 1999-12-31T23:59:59.999Z is before 2000-01-01T00:00:00.000Z; nothing was stored');
    expect(timestampOutOfWindow(new Date(Number.NaN), NOW)).toMatch(/^TIMESTAMP_OUT_OF_WINDOW: a reading has no valid instant/);
  });
});

describe('services.telemetry.write refuses an instant outside the window', () => {
  it('ONE reading out of the window fails the WHOLE write, before the instrument is even looked up — nothing is read or stored', async () => {
    const lookup = vi.spyOn(prisma.instrument, 'findUnique').mockImplementation((() => { throw new Error('the database was touched'); }) as never);
    const svc = services();
    const ok = { key: 't', value: 1, ts: new Date(Date.now() - 60_000) };
    await expect(svc.telemetry.write('inst-1', [ok, { key: 'h', value: 2, ts: new Date(Date.now() + DEVICE_TS_MAX_AHEAD_MS + 60_000) }], 'rule_node:c:n'))
      .rejects.toThrow(/^TIMESTAMP_OUT_OF_WINDOW: .* is more than 10 minutes ahead/);
    await expect(svc.telemetry.write('inst-1', [{ key: 't', value: 1, ts: new Date('1970-01-21T00:00:00.000Z') }, ok], 'rule_node:c:n'))
      .rejects.toThrow(/^TIMESTAMP_OUT_OF_WINDOW: 1970-01-21T00:00:00.000Z is before 2000/);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('an in-window reading goes on to the write path (the instrument lookup is the first thing it does)', async () => {
    const lookup = vi.spyOn(prisma.instrument, 'findUnique').mockImplementation((async () => null) as never);
    await expect(services().telemetry.write('inst-1', [{ key: 't', value: 1, ts: new Date(Date.now() - 3_600_000) }], 'rule_node:c:n'))
      .rejects.toThrow(/^INSTRUMENT_NOT_FOUND/);
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
