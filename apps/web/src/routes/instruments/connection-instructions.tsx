import { useState } from 'react';
import { getApiBase } from '@/lib/api-base';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

/**
 * A protocol switcher over all seven transports, showing the connection
 * example for whichever one is selected.
 *
 * An instrument's token in fact works on any listener — ingest
 * authentication never checks transport — so instruments are no longer
 * pinned to one. The switcher opens on the instrument's stored `transport`
 * when supplied (back-compat with callers that still pass it) and falls
 * back to `http` once that field goes away.
 */

const ALL_TRANSPORTS = ['http', 'https', 'mqtt', 'mqtts', 'websocket', 'wss', 'tcp'] as const;
type Transport = (typeof ALL_TRANSPORTS)[number];

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
  /** Optional — a stored transport just picks the switcher's initial tab. */
  transport?: string;
  code: string;
  /** Plaintext token. Only ever available at creation / regeneration. */
  token?: string;
  /** True when this instrument is a gateway relaying telemetry for children. */
  isGateway?: boolean;
  /** The gateway's real linked children — drives the batch payload shape. */
  childCodes?: string[];
  /** Set on a CHILD instrument that is (also) reported via a gateway. */
  gatewayCode?: string;
}

export function ConnectionInstructions({
  transport,
  code,
  token,
  isGateway,
  childCodes,
  gatewayCode,
}: ConnectionInstructionsProps) {
  // The switcher opens on the instrument's stored transport when one was
  // supplied (existing callers still pass it), otherwise HTTP — the one
  // listener that's actually live.
  const initial: Transport =
    transport && (ALL_TRANSPORTS as readonly string[]).includes(transport)
      ? (transport as Transport)
      : 'http';
  const [selected, setSelected] = useState<Transport>(initial);

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
  const notLive = !LIVE_TRANSPORTS.has(selected);

  // A gateway sends ONE batch payload keyed by each child's code, not the
  // single-reading body an ordinary instrument sends. When there are no
  // linked children yet there is no correct payload to show — a placeholder
  // device map would be a lie a technician could paste and "succeed" with.
  const hasChildren = isGateway && (childCodes?.length ?? 0) > 0;
  const devicesPayload = hasChildren
    ? JSON.stringify(
        {
          devices: Object.fromEntries(
            (childCodes as string[]).map((c) => [c, { temperature: 21.5, humidity: 47 }]),
          ),
        },
        null,
        2,
      )
    : '';

  let body: React.ReactNode;

  if (isGateway && !hasChildren) {
    body = (
      <p className="text-sm text-slate-500">
        This gateway has no linked instruments yet — link instruments to this
        gateway first, then reconnect here for the real batch payload.
      </p>
    );
  } else {
    switch (selected) {
      case 'http':
      case 'https':
        body = (
          <>
            <Row label="Endpoint" value={`POST ${httpUrl}`} />
            <Row label="Auth" value={`Authorization: Bearer ${tok}`} />
            <CodeBlock
              text={
                isGateway
                  ? `curl -k -X POST ${httpUrl} \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -d '${devicesPayload}'`
                  : `curl -k -X POST ${httpUrl} \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"temperature": 21.5, "humidity": 47}'`
              }
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
              text={`mosquitto_pub -h <broker-host> -p ${selected === 'mqtts' ? '8883' : '1883'} \\\n  -t "${topic}" \\\n  -u "${tok}" \\\n  -m '${isGateway ? devicesPayload : '{"temperature": 21.5}'}'`}
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
              text={`const ws = new WebSocket("${wsUrl}", {\n  headers: { Authorization: "Bearer ${tok}" },\n});\nws.on("open", () => ws.send(JSON.stringify(${isGateway ? devicesPayload : '{ temperature: 21.5 }'})));`}
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
              text={
                isGateway
                  ? `{"token":"${tok}"}\n${devicesPayload}`
                  : `{"token":"${tok}"}\n{"temperature": 21.5}\n{"temperature": 21.7}`
              }
            />
            <p className="text-xs text-slate-500">
              A byte stream carries no headers, so the FIRST line must be the token
              object. Sockets that do not authenticate promptly are closed.
            </p>
          </>
        );
        break;

      default:
        body = <p className="text-sm text-slate-500">No connection example for transport &quot;{selected}&quot;.</p>;
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Protocol">
        {ALL_TRANSPORTS.map((t) => {
          const isSelected = t === selected;
          const isLive = LIVE_TRANSPORTS.has(t);
          return (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={isSelected}
              onClick={() => setSelected(t)}
              className={`rounded-md border px-2.5 py-1 text-xs font-medium ${
                isSelected
                  ? 'border-slate-800 bg-slate-800 text-white'
                  : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
              }`}
            >
              {t.toUpperCase()}
              {!isLive && (
                <span
                  aria-hidden="true"
                  className={`ml-1 inline-block h-1.5 w-1.5 rounded-full align-middle ${
                    isSelected ? 'bg-amber-300' : 'bg-amber-500'
                  }`}
                  title="Not accepting connections yet"
                />
              )}
            </button>
          );
        })}
      </div>
      {gatewayCode && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          This instrument is also reported by gateway <strong className="font-mono">{gatewayCode}</strong>.
          The credentials below remain valid for reporting directly.
        </div>
      )}
      {notLive && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          <strong>{selected.toUpperCase()} is not accepting connections yet.</strong>{' '}
          The instrument and its token are valid, but only HTTP/HTTPS ingest is
          running in this release. The details below are what this device will
          use once the {selected.toUpperCase()} listener ships.
        </div>
      )}
      {body}
    </div>
  );
}
