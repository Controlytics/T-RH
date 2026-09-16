import { describe, it, expect } from 'vitest';
import { publishDisposition } from '../mqtt-bridge.js';

/**
 * What the bridge does with a publish, by connection state and message kind.
 * Extracted so the rule can be tested without a broker; the handle's
 * `publish()` is a thin switch over it.
 *
 * The 2026-09-16 case: a RETAINED downlink while the broker is DOWN. mqtt.js
 * queues it and delivers on reconnect, but the callback fires only on PUBACK —
 * so every caller waited out its whole 2 s timeout per message. A profile-key
 * cascade of 400 removals held its HTTP response for ~27 minutes against a
 * broker that was simply off. Retained state is exactly the kind of message
 * that MAY wait for the reconnect, so the handle now resolves as soon as
 * mqtt.js has queued it.
 */
describe('publishDisposition', () => {
  it('publishes normally while connected, retained or not', () => {
    expect(publishDisposition({ retain: true, connected: true, closing: false })).toBe('publish');
    expect(publishDisposition({ retain: false, connected: true, closing: false })).toBe('publish');
  });

  it('refuses everything once the bridge is closing — the outgoing store is about to be discarded', () => {
    expect(publishDisposition({ retain: true, connected: true, closing: true })).toBe('reject-closing');
    expect(publishDisposition({ retain: false, connected: false, closing: true })).toBe('reject-closing');
  });

  it('refuses an EVENT while offline — a stale event flushed later is worse than none (2026-09-05)', () => {
    expect(publishDisposition({ retain: false, connected: false, closing: false })).toBe('reject-offline-event');
  });

  it('QUEUES a retained message while offline and does not wait for the acknowledgement', () => {
    expect(publishDisposition({ retain: true, connected: false, closing: false })).toBe('queue-offline-retained');
  });
});
