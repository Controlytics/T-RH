import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
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
