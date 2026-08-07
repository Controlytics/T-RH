import { useState } from 'react';
import { TRANSPORTS as ALL_TRANSPORTS, type Transport } from '@digilog/shared';
import { getApiBase } from '@/lib/api-base';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';
import { isTransportLive } from './live-transports';

/**
 * A protocol switcher over all seven transports, showing the connection
 * example for whichever one is selected.
 *
 * An instrument's token works on any listener — ingest authentication never
 * checks protocol — so an instrument stores no transport at all (the column
 * was dropped 2026-08-06). This switcher is the whole answer to "how do I
 * connect this device?": every protocol, one example each.
 *
 * The `transport` prop only chooses which tab opens first. Nothing in the app
 * passes it any more; it is kept because a caller that knows the protocol its
 * reader speaks can land the operator on the right tab, and the tests use it
 * to address a specific tab directly.
 *
 * THIS IS A REVERSAL, AND IT WAS DELIBERATE (2026-08-06). The original design
 * showed exactly ONE transport on purpose: the reasoning was that offering all
 * seven and letting the technician pick is how you get a device publishing to
 * the wrong topic — the commonest onboarding failure this component exists to
 * prevent. That protection turned out to be a fiction. The single transport
 * came from a stored `Instrument.transport` that nothing enforced, so a device
 * shown an MQTT example could still publish over HTTP and be accepted; hiding
 * the other six narrowed the display, not the behaviour.
 *
 * What actually prevents the failure now is the per-protocol
 * "<X> is not accepting connections yet" banner (see `./live-transports`).
 * It is keyed to which listeners the server really runs, so it stops a
 * technician configuring a protocol that does not exist — a check on reality
 * rather than on a self-asserted field. Do not re-narrow this to one transport
 * without first replacing that banner with something stronger.
 */

/**
 * Which transports are live is data, not UI, and lives in `./live-transports`.
 *
 * `mqtts` joined the set on 2026-08-06 and was NOT argued from `mqtt`: it is a
 * separate EMQX listener on 8883 with its own certificate, so the three
 * negative checks (cross-topic publish, borrowed client id, revoked token) were
 * re-run over TLS rather than carried over from the plaintext port. With all
 * seven live the banner below has no reachable subject left, which is exactly
 * why the predicate is imported rather than inlined — see that module.
 *
 * Do not add a transport because a plan says the listener landed. Connect over
 * it and read the row back first.
 */

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

/**
 * States the credential three (or four) ways so a technician can fill a
 * device's own configuration form without inferring anything from a command.
 *
 * Every protocol gets Token / Username / Password: a device's config screen
 * commonly asks for a generic username+password pair even when the wire
 * protocol underneath is bearer-auth or a bare token field, and a technician
 * with no protocol expertise should not have to guess which box the token
 * goes in. Password is never rendered blank — an empty value reads as a
 * rendering bug and invites the technician to invent something — so it says
 * the words "leave empty" instead.
 *
 * Client ID is the one field that is NOT universal: only MQTT and MQTTS
 * require it (the broker's ACL templates on `${clientid}` and its auth hook
 * refuses any CONNECT whose clientid does not match the token's instrument),
 * so it is shown only for those two and left out everywhere else to avoid
 * cluttering protocols that have no such concept.
 */
function CredentialRows({
  token,
  clientId,
  showClientId,
}: {
  token: string;
  /** The instrument's UUID — the broker binds the client id to it. */
  clientId: string;
  showClientId: boolean;
}) {
  return (
    <div className="space-y-1 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <Row label="Token" value={token} />
      <Row label="Username" value={token} />
      <p className="text-xs text-slate-500">Username is the same as the token.</p>
      <Row label="Password" value="leave empty" />
      {showClientId && <Row label="Client ID" value={clientId} />}
    </div>
  );
}

export interface ConnectionInstructionsProps {
  /** Optional — picks the switcher's initial tab only. Not a stored fact. */
  transport?: string;
  /**
   * The instrument's UUID. THIS is what the wire uses — the MQTT client id and
   * every topic segment (2026-08-07): the code became free text, and a code
   * containing `/`, `+` or `#` would forge a topic shape or match the broker's
   * ACL against every instrument.
   */
  id: string;
  /** The human reference. Shown, never sent. */
  code: string;
  /** Plaintext token. Only ever available at creation / regeneration. */
  token?: string;
  /** True when this instrument is a gateway relaying telemetry for children. */
  isGateway?: boolean;
  /** The gateway's real linked children — drives the batch payload shape. */
  childCodes?: string[];
  /** Set on a CHILD instrument that is (also) reported via a gateway. */
  gatewayCode?: string;
  /** That gateway's UUID — the topic segment its children are addressed under. */
  gatewayId?: string;
}

export function ConnectionInstructions({
  transport,
  id,
  code,
  token,
  isGateway,
  childCodes,
  gatewayCode,
  gatewayId,
}: ConnectionInstructionsProps) {
  // No caller supplies one today, so this is HTTP in practice — the transport
  // most devices speak and the safest tab to open on.
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
  const topic = `instruments/${id}/telemetry`;
  const wsUrl = `${base.replace(/^http/, 'ws')}/api/ingest/v1/ws`;
  const notLive = !isTransportLive(selected);

  /**
   * The DOWNLINK topic — the one a technician cannot guess.
   *
   * Everything else on this card tells a device how to PUBLISH. Attribute
   * changes travel the other way, and a CHILD's are addressed under its
   * GATEWAY: subscribing to `instruments/<own code>/attributes` is permitted by
   * the ACL, succeeds, and is then silent forever. That is precisely the wrong
   * answer a reasonable person arrives at unaided, which is why it is stated
   * here rather than left to the docs.
   *
   * A GATEWAY gets the wildcard. `#` matches its own two-segment slot as well
   * as every child's three-segment one, so one subscription covers everything
   * it is responsible for.
   */
  const attributeTopic = isGateway
    ? `instruments/${id}/attributes/#`
    : gatewayId
      ? `instruments/${gatewayId}/attributes/${id}`
      : `instruments/${id}/attributes`;
  // Only a gateway has a roster, and only it may subscribe to one.
  const rosterTopic = isGateway ? `instruments/${id}/children` : null;
  // Subscribing is a BROKER capability. The WEBSOCKET/WSS tabs here are the
  // API's own /api/ingest/v1/ws ingest endpoint, not the broker's MQTT-over-WS
  // listener, and HTTP/TCP have no subscribe at all — showing a topic on any of
  // them would be a lie a technician could act on.
  const canSubscribe = selected === 'mqtt' || selected === 'mqtts';
  // Shared head of both one-line commands. `--cafile` stays on MQTTS: without
  // it the client cannot validate the broker and simply refuses to connect.
  const brokerPort = selected === 'mqtts' ? '8883' : '1883';
  const cafile = selected === 'mqtts' ? ' --cafile "<ca-cert.pem>"' : '';
  const pubPrefix = `mosquitto_pub -h <broker-host> -p ${brokerPort}${cafile} -i "${id}"`;
  const subPrefix = `mosquitto_sub -h <broker-host> -p ${brokerPort}${cafile} -i "${id}"`;

  // A gateway sends ONE batch payload keyed by each child's code, not the
  // single-reading body an ordinary instrument sends. When there are no
  // linked children yet there is no correct payload to show — a placeholder
  // device map would be a lie a technician could paste and "succeed" with.
  const hasChildren = isGateway && (childCodes?.length ?? 0) > 0;
  const devices = hasChildren
    ? {
        devices: Object.fromEntries(
          (childCodes as string[]).map((c) => [c, { temperature: 21.5, humidity: 47 }]),
        ),
      }
    : null;
  // Indented for the HTTP / WS / TCP examples, which are already multi-line.
  const devicesPayload = devices ? JSON.stringify(devices, null, 2) : '';
  // Compact for the one-line broker commands — an indented payload would put
  // the newlines straight back into the line this is meant to keep single.
  const compactDevicesPayload = devices ? JSON.stringify(devices) : '';

  let body: React.ReactNode;

  if (isGateway && !hasChildren) {
    body = (
      <p className="text-sm text-slate-500">
        This gateway has no linked instruments yet — link instruments to this
        gateway first, then reconnect here for the real batch payload.
      </p>
    );
  } else {
    const showClientId = selected === 'mqtt' || selected === 'mqtts';
    const credentialRows = <CredentialRows token={tok} clientId={id} showClientId={showClientId} />;

    switch (selected) {
      case 'http':
      case 'https':
        body = (
          <>
            {credentialRows}
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
        // ONE LINE, and prose-free (2026-08-07, operator request). The flags
        // that used to carry a paragraph each — `-i` must be the instrument
        // code, `-P ""` must be present even though the password is empty —
        // are still IN the command, so a pasted line stays correct. What was
        // removed is the explanation of why, which now lives only in
        // LOCAL_SETUP_WINDOWS.md §9A.3. Do not "tidy" either flag out of the
        // command: the broker denies the CONNECT without them, and there is no
        // longer any text on this card to tell the reader that.
        body = (
          <>
            {credentialRows}
            <Row label="Topic" value={topic} />
            <CodeBlock text={`${pubPrefix} -t "${topic}" -u "${tok}" -P "" -m '${isGateway ? compactDevicesPayload : '{"temperature": 21.5}'}'`} />
          </>
        );
        break;

      case 'websocket':
      case 'wss':
        body = (
          <>
            {credentialRows}
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
            {credentialRows}
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
          const isLive = isTransportLive(t);
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
          The instrument and its token are valid, and every other protocol on
          this list is live — but the {selected.toUpperCase()} listener has not
          been brought up and verified. Use MQTT on the broker&apos;s plaintext
          port, or one of the TLS-terminated transports (HTTPS, WSS), until it
          has. The details below are what this device will use once it ships.
        </div>
      )}
      {body}

      {/* Rendered OUTSIDE `body` on purpose: a gateway with no children takes
          the early-return branch above (there is no honest batch payload to
          show yet), but it still has its own attribute slot and an empty
          roster, and it is exactly the instrument someone is configuring when
          they most need this. */}
      {canSubscribe && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-sm font-medium text-slate-700">Attribute updates (platform → device)</p>
          <Row label="Attributes topic" value={attributeTopic} />
          {rosterTopic && <Row label="Children topic" value={rosterTopic} />}
          <CodeBlock text={`${subPrefix} -t "${attributeTopic}" -u "${tok}" -P "" -v`} />
          {rosterTopic && (
            <CodeBlock text={`${subPrefix} -t "${rosterTopic}" -u "${tok}" -P "" -v`} />
          )}
        </div>
      )}
    </div>
  );
}
