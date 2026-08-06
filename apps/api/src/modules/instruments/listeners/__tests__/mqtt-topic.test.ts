import { describe, it, expect } from 'vitest';
import { parseTelemetryTopic } from '../mqtt-bridge.js';

/**
 * Pure routing. A loose router is how `instruments/A/B/telemetry` gets filed
 * against instrument "A" — a message written to the wrong record, which in a
 * §11 system is worse than a message dropped.
 */
describe('parseTelemetryTopic', () => {
  it('extracts the code from a well-formed topic', () => {
    expect(parseTelemetryTopic('instruments/TEMP-01/telemetry')).toBe('TEMP-01');
  });

  it('rejects a topic with extra segments', () => {
    expect(parseTelemetryTopic('instruments/A/B/telemetry')).toBeNull();
    expect(parseTelemetryTopic('instruments/TEMP-01/telemetry/extra')).toBeNull();
  });

  it('rejects a code containing a slash', () => {
    // Impossible by the instrument-code charset, but the router must not be
    // the thing relying on that: a code that could carry a `/` would let one
    // instrument address another's topic shape.
    expect(parseTelemetryTopic('instruments/A/B/telemetry')).toBeNull();
    expect(parseTelemetryTopic('instruments//telemetry')).toBeNull();
  });

  it('rejects topics that do not match the pattern', () => {
    for (const t of [
      'instruments/TEMP-01/attributes',
      'devices/TEMP-01/telemetry',
      'instruments/TEMP-01',
      'telemetry',
      '',
      '/',
    ]) {
      expect(parseTelemetryTopic(t)).toBeNull();
    }
  });
});
