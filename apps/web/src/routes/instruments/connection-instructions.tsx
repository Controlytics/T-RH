import { useState } from 'react';
import { getApiBase } from '@/lib/api-base';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

/**
 * Exactly ONE connection example, for the instrument's own transport.
 *
 * Each instrument has a single transport by design, so there is exactly one
 * correct answer to "where do I send data?". Showing all seven and letting the
 * technician pick is how you get a device publishing to the wrong topic — the
 * commonest onboarding failure this component exists to prevent.
 */

/** P1 ships the HTTP listener only; the rest are catalogued but not yet served. */
const LIVE_TRANSPORTS = new Set(['http', 'https']);

function CodeBlock({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="relative">
      <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-slate-50 p-3 pr-20 text-xs text-slate-800 whitespace-pre-wrap break-all">
        {text}
      </pre>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
        }}
        className="absolute right-2 top-2 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs text-slate-600 hover:bg-slate-100"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2 text-sm">
      <span className="text-slate-500">{label}</span>
      <span className="font-mono text-slate-800 break-all">{value}</span>
    </div>
  );
}

export interface ConnectionInstructionsProps {
  transport: string;
  code: string;
  /** Plaintext token. Only ever available at creation / regeneration. */
  token?: string;
}

export function ConnectionInstructions({ transport, code, token }: ConnectionInstructionsProps) {
  // The token is knowable exactly once. When these instructions are shown on
  // the detail page (no token in hand) the example still has to be copyable, so
  // a placeholder stands in rather than an empty string that would paste as a
  // silently malformed command.
  const tok = token ?? '<ACCESS_TOKEN>';
  // getApiBase() is '' on the desktop browser (same-origin, proxied by Vite in
  // dev). That is right for fetch() and WRONG here: these examples are pasted
  // into a terminal, where `curl -X POST /api/ingest/v1/telemetry` is not a
  // command at all. Always resolve to something absolute.
  const base = getApiBase() || window.location.origin;
  const httpUrl = `${base}/api/ingest/v1/telemetry`;
  const topic = `instruments/${code}/telemetry`;
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/ingest/v1/ws`;
  const notLive = !LIVE_TRANSPORTS.has(transport);

  let body: React.ReactNode;
  switch (transport) {
    case 'http':
    case 'https':
      body = (
        <>
          <Row label="Endpoint" value={`POST ${httpUrl}`} />
          <Row label="Auth" value={`Authorization: Bearer ${tok}`} />
          <CodeBlock
            text={`curl -k -X POST ${httpUrl} \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"temperature": 21.5, "humidity": 47}'`}
          />
        </>
      );
      break;

    case 'mqtt':
    case 'mqtts':
      body = (
        <>
          <Row label="Topic" value={topic} />
          <Row label="Username" value={tok} />
          <Row label="Password" value="(leave empty)" />
          <CodeBlock
            text={`mosquitto_pub -h <broker-host> -p ${transport === 'mqtts' ? '8883' : '1883'} \\\n  -t "${topic}" \\\n  -u "${tok}" \\\n  -m '{"temperature": 21.5}'`}
          />
        </>
      );
      break;

    case 'websocket':
    case 'wss':
      body = (
        <>
          <Row label="Endpoint" value={wsUrl} />
          <Row label="Auth" value={`Authorization: Bearer ${tok}`} />
          <CodeBlock
            text={`const ws = new WebSocket("${wsUrl}", {\n  headers: { Authorization: "Bearer ${tok}" },\n});\nws.on("open", () => ws.send(JSON.stringify({ temperature: 21.5 })));`}
          />
        </>
      );
      break;

    case 'tcp':
      body = (
        <>
          <Row label="Host / port" value="<server-host>:1884" />
          <Row label="Framing" value="One JSON object per line (newline-delimited)" />
          <CodeBlock
            text={`{"token":"${tok}"}\n{"temperature": 21.5}\n{"temperature": 21.7}`}
          />
          <p className="text-xs text-slate-500">
            A byte stream carries no headers, so the FIRST line must be the token
            object. Sockets that do not authenticate promptly are closed.
          </p>
        </>
      );
      break;

    default:
      body = <p className="text-sm text-slate-500">No connection example for transport &quot;{transport}&quot;.</p>;
  }

  return (
    <div className="space-y-2">
      {notLive && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>{transport.toUpperCase()} is not accepting connections yet.</strong>{' '}
          The instrument and its token are valid, but only HTTP/HTTPS ingest is
          running in this release. The details below are what this device will
          use once the {transport.toUpperCase()} listener ships.
        </div>
      )}
      {body}
    </div>
  );
}
