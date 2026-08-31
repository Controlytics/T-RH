import { describe, it, expect } from 'vitest';
import { decideInactivity, quietMinutes, type InactivitySample } from '../inactivity-decide.js';

const NOW = new Date('2026-08-31T12:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const sample = (over: Partial<InactivitySample> = {}): InactivitySample => ({
  reporting: false,
  lastSeenAt: minutesAgo(60),
  isActive: true,
  hasOpenAlarm: false,
  ...over,
});

describe('raising', () => {
  it('raises once an instrument has been quiet past the grace period', () => {
    expect(decideInactivity(sample({ lastSeenAt: minutesAgo(20) }), 15, NOW)).toBe('raise');
  });

  it('holds off while it is inside the grace period', () => {
    // The window that decides "offline" is 3 minutes on this installation, so a
    // brief blip crosses it. Raising there would write two permanent §11 rows for
    // a thirty-second network hiccup.
    expect(decideInactivity(sample({ lastSeenAt: minutesAgo(5) }), 15, NOW)).toBe('none');
  });

  it('treats the grace boundary as reached, not as still waiting', () => {
    expect(decideInactivity(sample({ lastSeenAt: minutesAgo(15) }), 15, NOW)).toBe('raise');
  });

  it('raises immediately when the grace is zero', () => {
    expect(decideInactivity(sample({ lastSeenAt: minutesAgo(1) }), 0, NOW)).toBe('raise');
  });

  it('never raises a second alarm while one is open', () => {
    expect(decideInactivity(sample({ lastSeenAt: minutesAgo(600), hasOpenAlarm: true }), 15, NOW)).toBe('none');
  });

  it('does not raise for an instrument that has NEVER reported', () => {
    // It has not gone inactive; it was never active. Otherwise every instrument
    // created before it is wired up alarms at once, and the alarm can never clear
    // — there is no telemetry coming to clear it.
    expect(decideInactivity(sample({ lastSeenAt: null }), 15, NOW)).toBe('none');
  });

  it('does not raise for a decommissioned instrument', () => {
    // buildTelemetryOverview does not filter on isActive, so this is the guard.
    // A retired instrument is silent on purpose and must not alarm forever.
    expect(decideInactivity(sample({ isActive: false, lastSeenAt: minutesAgo(600) }), 15, NOW)).toBe('none');
  });

  it('does not raise while the instrument is still reporting', () => {
    expect(decideInactivity(sample({ reporting: true, lastSeenAt: minutesAgo(1) }), 15, NOW)).toBe('none');
  });

  it('does not raise on a device whose clock runs ahead', () => {
    // A future lastSeenAt would make the quiet span negative. isInstrumentReporting
    // already treats that as fresh; this must agree rather than raise on a
    // nonsense duration.
    expect(decideInactivity(sample({ lastSeenAt: new Date(NOW.getTime() + 60_000) }), 15, NOW)).toBe('none');
  });
});

describe('clearing', () => {
  it('clears the moment the instrument reports again', () => {
    // THE CLEAR SIGNAL IS PRESENCE. This is the opposite of the instrument-limit
    // pass, where a missing reading HOLDS an alarm open because absence cannot
    // prove recovery. Here absence IS the alarm, so presence is the proof — a
    // pass that inherited the limit rule would strand every inactivity alarm
    // ACTIVE for good.
    expect(decideInactivity(sample({ reporting: true, hasOpenAlarm: true }), 15, NOW)).toBe('clear');
  });

  it('clears without waiting out the grace period again', () => {
    // The grace delays RAISING only. An instrument that is back must not stay
    // alarmed for another fifteen minutes.
    const back = sample({ reporting: true, hasOpenAlarm: true, lastSeenAt: minutesAgo(0) });
    expect(decideInactivity(back, 600, NOW)).toBe('clear');
  });

  it('clears a decommissioned instrument that is somehow still reporting', () => {
    // Retiring an instrument must not strand an alarm that was already open. The
    // isActive guard suppresses RAISING; it must not suppress clearing.
    expect(decideInactivity(sample({ isActive: false, reporting: true, hasOpenAlarm: true }), 15, NOW)).toBe('clear');
  });

  it('does not clear an alarm that is not open', () => {
    expect(decideInactivity(sample({ reporting: true, hasOpenAlarm: false }), 15, NOW)).toBe('none');
  });

  it('keeps the alarm open while the instrument is still silent', () => {
    expect(decideInactivity(sample({ lastSeenAt: minutesAgo(600), hasOpenAlarm: true }), 15, NOW)).toBe('none');
  });
});

describe('quietMinutes', () => {
  it('measures the silence, for the alarm to state', () => {
    expect(quietMinutes(minutesAgo(90), NOW)).toBe(90);
  });

  it('is null when there is no last-seen to measure from', () => {
    expect(quietMinutes(null, NOW)).toBeNull();
  });

  it('never reports a negative span for a clock that runs ahead', () => {
    expect(quietMinutes(new Date(NOW.getTime() + 60_000), NOW)).toBe(0);
  });
});
