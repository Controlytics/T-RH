import { describe, it, expect } from 'vitest';
import { plaintextRemoteBrokerWarning } from '../mqtt-bridge.js';

/**
 * The bridge's subscription hop is plaintext ON PURPOSE while the broker is on
 * loopback — it carries the bridge's own static broker credential, never a
 * device token, and it never reaches a network.
 *
 * That reasoning stops holding the moment the broker moves, and until this
 * check existed the failure was SILENT: an operator edits the URL, the scheme
 * stays `mqtt://`, and the credential starts crossing a real network in the
 * clear with nothing anywhere saying so. These tests pin both directions,
 * because a warning that never fires and a warning that always fires are both
 * useless in the same way.
 */
describe('plaintextRemoteBrokerWarning', () => {
  it('stays silent for plaintext on loopback — the documented, intended setup', () => {
    expect(plaintextRemoteBrokerWarning('mqtt://127.0.0.1:1883')).toBeNull();
  });

  it('warns for plaintext against a remote broker, naming what is exposed', () => {
    const warning = plaintextRemoteBrokerWarning('mqtt://broker.plant.example:1883');
    expect(warning).not.toBeNull();
    // The operator who reads only this line must learn the CONSEQUENCE, not
    // that a setting looks unusual. Assert on the substance, not the wording.
    expect(warning).toMatch(/credential/i);
    expect(warning).toMatch(/clear|plaintext/i);
    expect(warning).toContain('broker.plant.example');
  });

  it('stays silent for a remote broker over mqtts — the actual fix', () => {
    // If this warned, the warning would be unactionable: doing the right thing
    // must silence it, or operators learn to ignore it.
    expect(plaintextRemoteBrokerWarning('mqtts://broker.plant.example:8883')).toBeNull();
  });

  it('treats the hostname `localhost` as loopback, not merely the literals', () => {
    // On Windows `localhost` resolves to ::1 first — the same asymmetry that
    // made the EMQX authenticator fail with econnrefused against an IPv4-only
    // bind. A check that only knew `127.0.0.1` would cry wolf on the single
    // most common local URL there is.
    expect(plaintextRemoteBrokerWarning('mqtt://localhost:1883')).toBeNull();
  });

  it('knows the whole loopback block, both families', () => {
    expect(plaintextRemoteBrokerWarning('mqtt://127.0.0.2:1883')).toBeNull();
    expect(plaintextRemoteBrokerWarning('mqtt://[::1]:1883')).toBeNull();
    expect(plaintextRemoteBrokerWarning('mqtt://dev.localhost:1883')).toBeNull();
  });

  it('does not mistake a lookalike host for loopback', () => {
    // The regression this guards: a substring or prefix test would wave these
    // through, and they are ordinary routable hosts.
    expect(plaintextRemoteBrokerWarning('mqtt://127.0.0.1.evil.example:1883')).not.toBeNull();
    expect(plaintextRemoteBrokerWarning('mqtt://localhost.evil.example:1883')).not.toBeNull();
    expect(plaintextRemoteBrokerWarning('mqtt://notlocalhost:1883')).not.toBeNull();
    expect(plaintextRemoteBrokerWarning('mqtt://10.0.0.5:1883')).not.toBeNull();
  });

  it('speaks up when the URL cannot be parsed rather than staying quiet', () => {
    // Unverifiable is not the same as safe. This URL will fail to connect
    // anyway, so a spurious warning costs nothing and silence could cost a
    // credential.
    const warning = plaintextRemoteBrokerWarning('not a url at all');
    expect(warning).not.toBeNull();
    expect(warning).toMatch(/parseable/i);
  });

  it('accepts the other encrypted transports mqtt.js supports', () => {
    expect(plaintextRemoteBrokerWarning('wss://broker.plant.example:8084')).toBeNull();
    expect(plaintextRemoteBrokerWarning('tls://broker.plant.example:8883')).toBeNull();
    // ...and still flags the plaintext websocket transport, which is not TLS.
    expect(plaintextRemoteBrokerWarning('ws://broker.plant.example:8083')).not.toBeNull();
  });
});
