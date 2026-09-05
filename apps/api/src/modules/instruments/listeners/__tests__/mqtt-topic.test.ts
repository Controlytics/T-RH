import { describe, it, expect } from 'vitest';
import { parseTelemetryTopic, isDownlinkTopic, TELEMETRY_TOPIC_FILTER } from '../mqtt-bridge.js';

/**
 * Pure routing. A loose router is how a message gets filed against the wrong
 * record — in a §11 system worse than a message dropped.
 *
 * Since 2026-09-04 the segment between `instruments/` and `/telemetry` is the
 * instrument CODE, and codes at this plant are `CWH/RDU/001-00` — so the
 * segment can itself contain slashes and the router matches a FIXED PREFIX and
 * SUFFIX rather than counting levels. What keeps that unambiguous is the rule
 * in `@digilog/shared` that a code's last segment is never a topic keyword.
 */
describe('parseTelemetryTopic', () => {
  it('extracts a simple code', () => {
    expect(parseTelemetryTopic('instruments/TEMP-01/telemetry')).toBe('TEMP-01');
  });

  it('extracts a slash-separated code — the plant\'s real shape', () => {
    expect(parseTelemetryTopic('instruments/CWH/RDU/001-00/telemetry')).toBe('CWH/RDU/001-00');
    expect(parseTelemetryTopic('instruments/A/B/telemetry')).toBe('A/B');
  });

  it('keeps leading, trailing and doubled slashes inside the code verbatim', () => {
    // The ACL template reproduces `${clientid}` literally, so these are exact
    // topics for exact codes — normalising them would file one instrument's
    // readings against another's.
    expect(parseTelemetryTopic('instruments/A//telemetry')).toBe('A/');
    expect(parseTelemetryTopic('instruments//A/telemetry')).toBe('/A');
  });

  it('rejects an empty code', () => {
    expect(parseTelemetryTopic('instruments//telemetry')).toBeNull();
    expect(parseTelemetryTopic('instruments/telemetry')).toBeNull();
  });

  it('rejects a trailing segment after the keyword', () => {
    expect(parseTelemetryTopic('instruments/TEMP-01/telemetry/extra')).toBeNull();
  });

  it('rejects a code carrying a wildcard, even though a publish cannot carry one', () => {
    // Belt and braces: registration refuses these codes, and the broker refuses
    // a publish to a wildcard topic. The router must not be the layer relying
    // on either.
    expect(parseTelemetryTopic('instruments/+/telemetry')).toBeNull();
    expect(parseTelemetryTopic('instruments/A/#/telemetry')).toBeNull();
  });

  it('rejects topics that do not match the pattern', () => {
    for (const t of [
      'instruments/TEMP-01/attributes',
      'instruments/GW-1/attributes/CH-1',
      'instruments/GW-1/children',
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

describe('isDownlinkTopic', () => {
  it('recognises the three retained slots the bridge itself publishes', () => {
    // Subscribing `instruments/#` means the bridge is handed its own retained
    // downlinks on every (re)subscribe. They are ignored SILENTLY — logging
    // them as "dropped" on every reconnect would bury a real drop.
    expect(isDownlinkTopic('instruments/TEMP-01/attributes')).toBe(true);
    expect(isDownlinkTopic('instruments/GW-1/attributes/CWH/RDU/001-00')).toBe(true);
    expect(isDownlinkTopic('instruments/GW-1/children')).toBe(true);
  });

  it('does not claim a telemetry topic, whatever the code contains', () => {
    // Check order in the bridge is telemetry FIRST, and this must agree: a code
    // may contain `attributes` in a middle segment.
    expect(isDownlinkTopic('instruments/X/attributes/Y/telemetry')).toBe(false);
    expect(isDownlinkTopic('instruments/TEMP-01/telemetry')).toBe(false);
  });

  it('does not claim topics outside the instruments tree', () => {
    expect(isDownlinkTopic('devices/GW-1/children')).toBe(false);
    expect(isDownlinkTopic('')).toBe(false);
  });
});

describe('TELEMETRY_TOPIC_FILTER', () => {
  it('covers a slash-separated code — `+` is exactly one level and could not', () => {
    expect(TELEMETRY_TOPIC_FILTER).toBe('instruments/#');
  });
});
