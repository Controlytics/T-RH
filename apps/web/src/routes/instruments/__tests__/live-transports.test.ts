import { describe, it, expect } from 'vitest';
import { TRANSPORTS } from '@digilog/shared';
import { LIVE_TRANSPORTS, isTransportLive } from '../live-transports';

describe('live-transports', () => {
  it('claims a transport is live only for the seven verified listeners', () => {
    // A literal, not a loop over TRANSPORTS: this set is a factual claim about
    // what was connected to and read back on 2026-08-06, so adding a transport
    // must require editing this line and saying so, not fall out of a schema
    // change somewhere else.
    expect([...LIVE_TRANSPORTS].sort()).toEqual(
      ['http', 'https', 'mqtt', 'mqtts', 'tcp', 'websocket', 'wss'].sort(),
    );
  });

  it('is keyed on the UI transport ids, so no member is a silent no-op', () => {
    // The listener stamps 'ws' on dead-letters while the UI id is 'websocket'.
    // A member that matches no UI id would never be consulted and would read as
    // a live transport that is quietly still warning.
    for (const t of LIVE_TRANSPORTS) {
      expect(TRANSPORTS as readonly string[]).toContain(t);
    }
  });

  it('does not vouch for a transport it has never heard of', () => {
    // The predicate must default to "not live". If an unknown id ever returned
    // true the banner would be unreachable for real, rather than merely having
    // no subject today.
    expect(isTransportLive('carrier-pigeon')).toBe(false);
    expect(isTransportLive('')).toBe(false);
  });

  it('vouches for mqtts — verified over TLS, not inferred from mqtt', () => {
    expect(isTransportLive('mqtts')).toBe(true);
  });
});
