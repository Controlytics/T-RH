import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionInstructions } from '../connection-instructions';

// With all seven transports live, the not-live banner has no reachable subject
// through the component's public API — an unrecognised `transport` prop falls
// back to `http`. Rather than let the banner's logic rot into dead code, the
// liveness predicate is a separate module and this override can force a single
// transport un-live, exactly as one would be on the day a listener is added
// ahead of its verification. `vi.hoisted` because `vi.mock` is hoisted above
// ordinary declarations.
const forceNotLive = vi.hoisted(() => ({ transport: null as string | null }));
vi.mock('../live-transports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../live-transports')>();
  return {
    ...actual,
    isTransportLive: (t: string) =>
      forceNotLive.transport === t ? false : actual.isTransportLive(t),
  };
});

describe('ConnectionInstructions', () => {
  it('shows a curl example for http', () => {
    render(<ConnectionInstructions transport="http" code="T-1" token="TOK" />);
    expect(screen.getByText(/curl/)).toBeInTheDocument();
    // getAllByText: the token appears both as the labelled auth header and
    // inside the paste-ready command. Both are wanted — one tells you what the
    // device must send, the other lets you prove it works without typing it.
    expect(screen.getAllByText(/Bearer TOK/).length).toBeGreaterThan(0);
  });

  it('shows the topic and username for mqtt', () => {
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/instruments\/T-1\/telemetry/).length).toBeGreaterThan(0);
  });

  it('shows exactly one example — never all transports at once', () => {
    render(<ConnectionInstructions transport="http" code="T-1" token="TOK" />);
    expect(screen.queryByText(/mosquitto_pub/)).not.toBeInTheDocument();
  });

  it('renders an ABSOLUTE endpoint — a relative URL is not a runnable curl', () => {
    // getApiBase() returns '' on the desktop browser (same-origin). Pasting
    // `curl -X POST /api/ingest/v1/telemetry` into a terminal does nothing,
    // which defeats the entire purpose of showing a paste-ready command.
    render(<ConnectionInstructions transport="http" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/https?:\/\/[^/\s]+\/api\/ingest\/v1\/telemetry/).length).toBeGreaterThan(0);
  });

  it('still warns for a transport whose listener is not verified', () => {
    // MQTTS was this test's subject until 2026-08-06, when it was verified and
    // the set became all seven. The banner is the whole reason a technician
    // does not spend an hour debugging their device against a listener that is
    // not there, so it keeps its coverage: force one transport un-live and the
    // warning must still appear. Delete this and the next transport added ahead
    // of its listener ships silently claiming to work.
    forceNotLive.transport = 'mqtts';
    try {
      render(<ConnectionInstructions transport="mqtts" code="T-1" token="TOK" />);
      expect(screen.getByText(/not accepting connections yet/i)).toBeInTheDocument();
    } finally {
      forceNotLive.transport = null;
    }
  });

  // The flip side of the banner. These pin the seven transports verified live
  // on 2026-08-06; a listener regressing out of the app must break a test here
  // rather than leaving the UI quietly promising something it cannot do.
  it.each(['http', 'https', 'tcp', 'websocket', 'wss', 'mqtt', 'mqtts'])(
    'shows no not-live banner for %s — its listener is verified',
    (t) => {
      render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
      expect(screen.queryByText(/not accepting connections yet/i)).not.toBeInTheDocument();
    },
  );

  it('gives the MQTTS example a CA file, an empty password and the TLS port', () => {
    // Every one of these is load-bearing, and each was found by running the
    // command rather than reading it. Without --cafile the client cannot
    // validate the broker; without -P "" the broker rejects the CONNECT before
    // the token is looked up (a username with no password field at all), which
    // surfaces as "bad user name or password" and reads like a bad token.
    render(<ConnectionInstructions transport="mqtts" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/-p 8883/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/--cafile/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-P ""/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-i "T-1"/).length).toBeGreaterThan(0);
  });

  it('gives the plaintext MQTT example the empty password too, on port 1883', () => {
    // The -P "" requirement is the broker's, not TLS's — it applies equally to
    // the plaintext listener, whose example was already shipped without it.
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/-p 1883/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-P ""/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/--cafile/)).not.toBeInTheDocument();
  });

  it('gives the MQTT example the instrument code as the client id', () => {
    // Not cosmetic. The broker's topic ACL is written against ${clientid} and
    // POST /api/ingest/v1/mqtt-auth denies any CONNECT whose clientid is not
    // the token's instrument code — so a mosquitto_pub line without -i is
    // refused outright. An example missing it is an example that cannot work.
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/-i "T-1"/).length).toBeGreaterThan(0);
  });
});

describe('ConnectionInstructions — credential triple', () => {
  it('presents Username as equal to the token, for every protocol', () => {
    // Not "similar to" — a technician pastes this into a config form's
    // Username box, so the displayed value must be the literal token, not a
    // paraphrase, and the row must say the two are the same thing.
    for (const t of ['http', 'https', 'websocket', 'wss', 'tcp', 'mqtt', 'mqtts']) {
      const { unmount } = render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
      const usernameRow = screen.getByText('Username').closest('div');
      expect(usernameRow).not.toBeNull();
      expect(usernameRow?.textContent).toContain('TOK');
      expect(screen.getByText(/Username is the same as the token/i)).toBeInTheDocument();
      unmount();
    }
  });

  it('tells Password to be left empty rather than rendering a blank value', () => {
    render(<ConnectionInstructions transport="http" code="T-1" token="TOK" />);
    const passwordRow = screen.getByText('Password').closest('div');
    expect(passwordRow?.textContent).toMatch(/leave empty/i);
    // A blank value would render as just the label with nothing after it —
    // guard against that regression directly.
    expect(passwordRow?.textContent).not.toBe('Password');
  });

  it('shows Client ID with the instrument code for MQTT and MQTTS', () => {
    for (const t of ['mqtt', 'mqtts']) {
      const { unmount } = render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
      const clientIdRow = screen.getByText('Client ID').closest('div');
      expect(clientIdRow?.textContent).toContain('T-1');
      unmount();
    }
  });

  it('does not show a Client ID row for protocols that have no such concept', () => {
    for (const t of ['http', 'https', 'websocket', 'wss', 'tcp']) {
      const { unmount } = render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
      expect(screen.queryByText('Client ID')).not.toBeInTheDocument();
      unmount();
    }
  });

  it('shows an explicit Token row for every protocol', () => {
    for (const t of ['http', 'https', 'websocket', 'wss', 'tcp', 'mqtt', 'mqtts']) {
      const { unmount } = render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
      const tokenRow = screen.getByText('Token').closest('div');
      expect(tokenRow?.textContent).toContain('TOK');
      unmount();
    }
  });

  it('keeps the MQTT pasteable command carrying -i <code> and -P "" alongside the labelled rows', () => {
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/-i "T-1"/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-P ""/).length).toBeGreaterThan(0);
  });
});

describe('ConnectionInstructions — gateway', () => {
  it('shows the devices batch shape naming this gateway\'s real children', () => {
    render(
      <ConnectionInstructions transport="http" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A', 'SENSOR-B']} />,
    );
    // Not an illustrative example — the correct command for THIS gateway.
    expect(screen.getAllByText(/"devices"/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SENSOR-A/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SENSOR-B/).length).toBeGreaterThan(0);
  });

  it('tells a gateway with no children to link some first', () => {
    render(<ConnectionInstructions transport="http" code="GW-1" token="TOK" isGateway childCodes={[]} />);
    expect(screen.getByText(/link.*instrument/i)).toBeInTheDocument();
  });

  it('tells a child it is reported via its gateway, without hiding its own credentials', () => {
    render(<ConnectionInstructions transport="http" code="SENSOR-A" token="TOK" gatewayCode="GW-1" />);
    expect(screen.getByText(/GW-1/)).toBeInTheDocument();
    expect(screen.getByText(/curl/)).toBeInTheDocument();   // direct path still shown (spec D4)
  });
});

describe('ConnectionInstructions — protocol switcher', () => {
  it('defaults to HTTP when no transport is supplied', () => {
    render(<ConnectionInstructions code="T-1" token="TOK" />);
    expect(screen.getByText(/curl/)).toBeInTheDocument();
    expect(screen.queryByText(/mosquitto_pub/)).not.toBeInTheDocument();
    expect(screen.queryByText(/not accepting connections yet/i)).not.toBeInTheDocument();
  });

  it('selecting MQTT shows the MQTT topic, and no warning now that it is live', () => {
    render(<ConnectionInstructions code="T-1" token="TOK" />);
    fireEvent.click(screen.getByRole('tab', { name: /^MQTT$/ }));
    expect(screen.getAllByText(/instruments\/T-1\/telemetry/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/not accepting connections yet/i)).not.toBeInTheDocument();
  });

  it('switching away from a not-live transport removes the warning', () => {
    // Pins that the banner tracks the SELECTED tab and is not a one-shot on
    // mount — with the same override the earlier banner test uses, since no
    // real transport can raise it any more.
    forceNotLive.transport = 'mqtts';
    try {
      render(<ConnectionInstructions code="T-1" token="TOK" />);
      fireEvent.click(screen.getByRole('tab', { name: /^MQTTS$/ }));
      expect(screen.getByText(/not accepting connections yet/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('tab', { name: /^HTTP$/ }));
      expect(screen.queryByText(/not accepting connections yet/i)).not.toBeInTheDocument();
      expect(screen.getByText(/curl/)).toBeInTheDocument();
    } finally {
      forceNotLive.transport = null;
    }
  });

  it('a gateway batch payload survives a protocol switch', () => {
    render(
      <ConnectionInstructions code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A', 'SENSOR-B']} />,
    );
    expect(screen.getAllByText(/"devices"/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: /^TCP$/ }));
    expect(screen.getAllByText(/SENSOR-A/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/SENSOR-B/).length).toBeGreaterThan(0);
  });
});
