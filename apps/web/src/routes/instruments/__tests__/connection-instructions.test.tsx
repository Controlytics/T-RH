import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
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
    expect(screen.getByText((t) => t.startsWith('curl -k -X POST') && t.includes('/api/ingest/v1/telemetry'))).toBeInTheDocument();
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

  it('gives the MQTT example the instrument CODE as the client id', () => {
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

  it('shows Client ID with the instrument CODE for MQTT and MQTTS', () => {
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
    expect(screen.getByText((t) => t.startsWith('curl -k -X POST') && t.includes('/api/ingest/v1/telemetry'))).toBeInTheDocument();   // direct path still shown (spec D4)
  });
});

describe('ConnectionInstructions — protocol switcher', () => {
  it('defaults to HTTP when no transport is supplied', () => {
    render(<ConnectionInstructions code="T-1" token="TOK" />);
    expect(screen.getByText((t) => t.startsWith('curl -k -X POST') && t.includes('/api/ingest/v1/telemetry'))).toBeInTheDocument();
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
      expect(screen.getByText((t) => t.startsWith('curl -k -X POST') && t.includes('/api/ingest/v1/telemetry'))).toBeInTheDocument();
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

/**
 * The DOWNLINK half of "how do I connect this device?" (2026-08-07).
 *
 * Everything above tells a technician how to PUBLISH. The attribute topic is
 * the other direction, and it is the one that cannot be guessed: a child's
 * attributes are addressed under its GATEWAY, so the obvious
 * `instruments/<own code>/attributes` is silently wrong for exactly the
 * instruments a technician is most likely to be configuring.
 */
describe('ConnectionInstructions — attribute downlink', () => {
  const subscribeTabs = ['MQTT', 'MQTTS'] as const;

  // The card was stripped of prose on 2026-08-07 at the operator's request, so
  // a pasted line is now the whole instruction. Both flags the removed
  // paragraphs used to explain are load-bearing — the broker denies the CONNECT
  // without either — and nothing on the page would tell a reader why. These two
  // pin them into the command itself.
  it.each(subscribeTabs)('keeps the client-id and empty-password flags in both commands (%s)', (tab) => {
    render(
      <ConnectionInstructions transport={tab.toLowerCase()} code="GW-9" token="TOK" isGateway childCodes={['C-1']} />,
    );
    // A gateway shows FOUR publish commands since 2026-09-05 — the batch, the
    // one-child-per-message form, the attribute report and the RTC request —
    // and every command must carry the flags.
    const pubs = screen.getAllByText(/mosquitto_pub/);
    expect(pubs.length).toBe(4);
    for (const cmd of [...pubs, ...screen.getAllByText(/mosquitto_sub/)]) {
      expect(cmd.textContent).toContain('-i "GW-9"');
      expect(cmd.textContent).toContain('-P ""');
    }
  });

  it.each(subscribeTabs)('states each command on ONE line (%s)', (tab) => {
    render(
      <ConnectionInstructions transport={tab.toLowerCase()} code="GW-9" token="TOK" isGateway childCodes={['C-1', 'C-2']} />,
    );
    // Including the gateway's batch payload, which is compact for this reason,
    // and the one-child-per-message form beside it.
    for (const cmd of [...screen.getAllByText(/mosquitto_pub/), ...screen.getAllByText(/mosquitto_sub/)]) {
      expect(cmd.textContent).not.toContain('\n');
      expect(cmd.textContent).not.toContain('\\');
    }
  });

  it.each(subscribeTabs)('shows a standalone instrument its own attribute topic (%s)', (tab) => {
    render(<ConnectionInstructions transport={tab.toLowerCase()} code="T-1" token="TOK" />);
    expect(screen.getAllByText(/instruments\/T-1\/attributes/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/mosquitto_sub/).length).toBeGreaterThan(0);
  });

  // The whole reason this is in the UI: a child subscribing to its own code
  // gets a valid, permitted, permanently silent subscription.
  it('addresses a CHILD under its gateway, not under itself', () => {
    render(<ConnectionInstructions transport="mqtt" code="CH-1" token="TOK" gatewayCode="GW-1" />);
    // The subscribe command — the thing that actually gets pasted — must carry
    // the gateway form and nothing else.
    const cmd = screen.getByText(/mosquitto_sub/).textContent ?? '';
    expect(cmd).toContain('-t "instruments/GW-1/attributes/CH-1"');
    // The card carries no prose since 2026-08-07, so the command is the ONLY
    // place the right topic is stated — the child's own code must not appear as
    // a STANDALONE topic anywhere on it (it is the client id, and the last
    // segment under the gateway, and nothing else).
    expect(cmd).not.toContain('instruments/CH-1/attributes');
    // `instruments/CH-1/telemetry` DOES appear — a child that also connects
    // directly publishes there — so the assertion is on the attribute slot.
    // The child's own REPORT topic (`…/CH-1/attributes/report`, the device →
    // platform path) legitimately exists; it is the downlink SLOT that must not.
    expect(screen.queryByText(/instruments\/CH-1\/attributes(?!\/report)/)).not.toBeInTheDocument();
  });

  it('gives a gateway the wildcard covering its own slot and every child', () => {
    render(
      <ConnectionInstructions transport="mqtt" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A']} />,
    );
    expect(screen.getAllByText(/instruments\/GW-1\/attributes\/#/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/instruments\/GW-1\/children/).length).toBeGreaterThan(0);
  });

  // A gateway with no children still has its own attribute slot and an (empty)
  // roster. The batch-payload branch has nothing to show it; the downlink does.
  it('shows the topics to a gateway that has no children yet', () => {
    render(<ConnectionInstructions transport="mqtt" code="GW-2" token="TOK" isGateway />);
    expect(screen.getByText(/no linked instruments yet/i)).toBeInTheDocument();
    expect(screen.getAllByText(/instruments\/GW-2\/attributes\/#/).length).toBeGreaterThan(0);
  });

  // Only the broker transports can subscribe. The WEBSOCKET tab here is the
  // API's own /api/ingest/v1/ws endpoint, not the broker's MQTT-over-WS
  // listener, so showing a subscribe topic there would be a lie.
  it.each(['HTTP', 'HTTPS', 'WEBSOCKET', 'WSS', 'TCP'])('shows no subscribe topic on %s', (tab) => {
    render(<ConnectionInstructions transport={tab.toLowerCase()} code="T-1" token="TOK" />);
    expect(screen.queryByText(/mosquitto_sub/)).not.toBeInTheDocument();
    expect(screen.queryByText(/instruments\/T-1\/attributes/)).not.toBeInTheDocument();
  });
});

/**
 * The downlink PAYLOADS, shown the way the telemetry sample is (operator,
 * 2026-09-05: "show the payload for attributes … same like telemetry").
 */
describe('ConnectionInstructions — attribute payloads', () => {
  it('shows the per-instrument attribute payload: the full set plus the changed key', () => {
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    const blocks = screen.getAllByText(/"attributes"/);
    expect(blocks.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"changed"/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"High Temperature Limit": "27"/).length).toBeGreaterThan(0);
    // No bundle for a standalone instrument.
    expect(screen.queryByText(/children\/attributes/)).not.toBeInTheDocument();
  });

  it('shows a gateway the whole-set bundle topic and payload naming its real children', () => {
    render(
      <ConnectionInstructions transport="mqtt" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A', 'SENSOR-B']} />,
    );
    expect(screen.getAllByText(/instruments\/GW-1\/children\/attributes/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"gateway": "GW-1"/).length).toBeGreaterThan(0);
    // The change event is the telemetry batch's shape: one block under
    // `devices`, `devN` then ONLY the key that moved.
    expect(screen.getAllByText(/"devN": "SENSOR-A",\s*"High Temperature Limit": "27"\s*\}/).length).toBeGreaterThan(0);
    // And the roster payload, keyed the same way.
    expect(screen.getAllByText(/"isActive": true/).length).toBeGreaterThan(0);
  });

  it('shows a gateway the one-child-per-message flat form beside the batch, keyed t and h', () => {
    render(
      <ConnectionInstructions transport="mqtt" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A', 'SENSOR-B']} />,
    );
    // The batch: a list of blocks, each opening with devN, readings keyed t / h.
    expect(screen.getAllByText(/"devices":\[\{"devN":"SENSOR-A","t":21.5,"h":47\}/).length).toBeGreaterThan(0);
    // The flat per-sensor form, on the same topic.
    expect(screen.getAllByText(/-m '\{"devN":"SENSOR-A","t":21.5,"h":47\}'/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/"temperature"/)).not.toBeInTheDocument();
  });

  it('shows the device → platform report topic and a sample, per instrument kind', () => {
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.getAllByText(/instruments\/T-1\/attributes\/report/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-m '\{"Location":"LCMS Room-II"\}'/).length).toBeGreaterThan(0);
    cleanup();
    render(<ConnectionInstructions transport="mqtt" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A']} />);
    expect(screen.getAllByText(/instruments\/GW-1\/attributes\/report/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/"devices":\[\{"devN":"SENSOR-A","Location":"LCMS Room-II"\}\]/).length).toBeGreaterThan(0);
  });

  it('shows a gateway the RTC request topic, the global time topic and a time sample; not a standalone instrument', () => {
    render(<ConnectionInstructions transport="mqtt" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A']} />);
    expect(screen.getAllByText(/instruments\/GW-1\/rtc-request/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-m '\{"method":"getTime"\}'/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/digilog\/rtc\/time/).length).toBeGreaterThan(0);
    // The payload is exactly {"unix":<13-digit epoch-ms>} — no method, no ISO string.
    expect(screen.getAllByText(/^\{"unix":\d{13}\}$/).length).toBeGreaterThan(0);
    expect(screen.queryByText(/"method": "time"/)).toBeNull();
    expect(screen.queryByText(/"utc"/)).toBeNull();
    cleanup();
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.queryByText(/rtc-request/)).not.toBeInTheDocument();
  });

  // HTTP's GET answer is the SET — no change delta, no MQTT change topic.
  it('shows no change payload and no change topic on HTTP', () => {
    render(<ConnectionInstructions transport="http" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A']} />);
    expect(screen.queryByText(/"changed"/)).not.toBeInTheDocument();
    expect(screen.queryByText(/children\/attributes/)).not.toBeInTheDocument();
  });
});

/**
 * Attributes on EVERY protocol (2026-10-28, operator: "why attributes topic
 * was not there for http and https" → "add for all protocals"). Each tab shows
 * its own way, never an MQTT topic: HTTP a GET and a POST, WS / TCP the
 * subscribe frame and the report envelope.
 */
describe('ConnectionInstructions — attributes on HTTP, WebSocket and TCP', () => {
  it.each(['http', 'https'])('%s: GET reads the set, POST reports', (t) => {
    render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
    const box = screen.getByTestId('attributes-non-mqtt');
    expect(box).toHaveTextContent('GET ');
    expect(box).toHaveTextContent('/api/ingest/v1/attributes');
    expect(box).toHaveTextContent('POST ');
    expect(box).toHaveTextContent('"Location":"LCMS Room-II"');
  });

  it.each(['websocket', 'wss', 'tcp'])('%s: subscribe frame and the attributes envelope', (t) => {
    render(<ConnectionInstructions transport={t} code="T-1" token="TOK" />);
    const box = screen.getByTestId('attributes-non-mqtt');
    expect(box).toHaveTextContent('{"subscribe":"attributes"}');
    expect(box).toHaveTextContent('"device": "T-1"');
    expect(box).toHaveTextContent('{"attributes":{"Location":"LCMS Room-II"}}');
  });

  it('a gateway on TCP is told it receives one message per instrument, its children named', () => {
    render(<ConnectionInstructions transport="tcp" code="GW-1" token="TOK" isGateway childCodes={['SENSOR-A']} />);
    const box = screen.getByTestId('attributes-non-mqtt');
    expect(box).toHaveTextContent(/one message per instrument/);
    expect(box).toHaveTextContent('"device": "SENSOR-A"');
  });

  it('MQTT keeps its topics and shows no copy of these', () => {
    render(<ConnectionInstructions transport="mqtt" code="T-1" token="TOK" />);
    expect(screen.queryByTestId('attributes-non-mqtt')).toBeNull();
  });
});
