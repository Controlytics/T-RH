import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConnectionInstructions } from '../connection-instructions';

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

  it('marks the transports that have no listener yet', () => {
    // P1 ships HTTP/HTTPS only. An instrument can be catalogued on any
    // transport, but showing paste-ready instructions for a listener that does
    // not exist would send a technician to debug their device for an hour.
    render(<ConnectionInstructions transport="tcp" code="T-1" token="TOK" />);
    expect(screen.getByText(/not accepting connections yet/i)).toBeInTheDocument();
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

  it('selecting MQTT shows the MQTT topic and the not-live warning', () => {
    render(<ConnectionInstructions code="T-1" token="TOK" />);
    fireEvent.click(screen.getByRole('tab', { name: /MQTT$/ }));
    expect(screen.getAllByText(/instruments\/T-1\/telemetry/).length).toBeGreaterThan(0);
    expect(screen.getByText(/not accepting connections yet/i)).toBeInTheDocument();
  });

  it('switching back to HTTP removes the warning', () => {
    render(<ConnectionInstructions code="T-1" token="TOK" />);
    fireEvent.click(screen.getByRole('tab', { name: /MQTT$/ }));
    expect(screen.getByText(/not accepting connections yet/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: /^HTTP$/ }));
    expect(screen.queryByText(/not accepting connections yet/i)).not.toBeInTheDocument();
    expect(screen.getByText(/curl/)).toBeInTheDocument();
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
