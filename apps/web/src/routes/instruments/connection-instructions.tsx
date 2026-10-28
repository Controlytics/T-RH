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
  /** The instrument's CODE — the broker binds the client id to it (2026-09-04). */
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
   * The instrument's code. THIS is what the wire uses — the MQTT client id and
   * every topic segment (2026-09-04, operator: "i want client id as
   * CWH/RDU/001-00"). Between 2026-08-07 and then it was the UUID. No
   * character rule since 2026-09-16 (operator) — a code with `+` or `#`
   * cannot publish, see `codeSchema` in `@digilog/shared`. A slash in the code
   * is a topic level the broker's ACL template reproduces literally.
   */
  code: string;
  /** Plaintext token. Only ever available at creation / regeneration. */
  token?: string;
  /** True when this instrument is a gateway relaying telemetry for children. */
  isGateway?: boolean;
  /** The gateway's real linked children — drives the batch payload shape. */
  childCodes?: string[];
  /**
   * Set on a CHILD instrument that is (also) reported via a gateway — the
   * topic segment its children are addressed under.
   */
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
  // A device's ATTRIBUTES over HTTP / HTTPS (2026-10-28): POST reports, GET reads.
  const attributesUrl = `${base}/api/ingest/v1/attributes`;
  const topic = `instruments/${code}/telemetry`;
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
    ? `instruments/${code}/attributes/#`
    : gatewayCode
      ? `instruments/${gatewayCode}/attributes/${code}`
      : `instruments/${code}/attributes`;
  // Only a gateway has a roster, and only it may subscribe to one.
  const rosterTopic = isGateway ? `instruments/${code}/children` : null;
  // And only a gateway has the whole-set BUNDLE (2026-09-05): every child's
  // complete attribute set in ONE retained message, beside the per-child slots.
  const bundleTopic = isGateway ? `instruments/${code}/children/attributes` : null;

  /**
   * SAMPLE downlink payloads (operator, 2026-09-05: "show the payload for
   * attributes … same like telemetry"). Shown the way the telemetry sample is:
   * the real codes this instrument carries, with example values — `21.5` on the
   * telemetry side, a limit and a location here. The keys are the ones every
   * instrument on this installation carries; the values are illustrative.
   */
  const sampleTs = '2026-09-05T07:49:47.847Z';
  const sampleAttributes = { 'High Temperature Limit': '27', 'Low Temperature Limit': '18', 'Location': 'LCMS Room-II' };
  // The per-instrument slot: the COMPLETE set, plus the one key that moved
  // (`null` = removed). The same shape on a standalone slot and a child's.
  const attributePayload = JSON.stringify({
    attributes: sampleAttributes,
    changed: { 'High Temperature Limit': '27' },
    ts: sampleTs,
  }, null, 2);
  // The gateway's CHANGE event: sent only when a child's attribute changes,
  // not retained — the child's code and ONLY the key that moved, in the
  // telemetry batch's shape.
  const bundleChildren = (childCodes && childCodes.length ? childCodes : ['<child code>']).slice(0, 2);
  const bundlePayload = JSON.stringify({
    gateway: code,
    devices: [{ devN: bundleChildren[0], 'High Temperature Limit': '27' }],
  }, null, 2);
  const rosterPayload = JSON.stringify({
    children: bundleChildren.map((c) => ({ code: c, name: c, isActive: true })),
    ts: sampleTs,
  }, null, 2);
  // Device → platform: this instrument's report topic and a compact sample in
  // the telemetry batch's shape — a gateway names each child under `devN`, a
  // standalone instrument sends its own keys flat.
  const reportTopic = `instruments/${code}/attributes/report`;
  const reportPayload = isGateway
    ? JSON.stringify({ devices: bundleChildren.map((c) => ({ devN: c, Location: 'LCMS Room-II' })) })
    : JSON.stringify({ Location: 'LCMS Room-II' });
  // Subscribing is a BROKER capability. The WEBSOCKET/WSS tabs here are the
  // API's own /api/ingest/v1/ws ingest endpoint, not the broker's MQTT-over-WS
  // listener, and HTTP/TCP have no subscribe at all — showing a topic on any of
  // them would be a lie a technician could act on.
  const canSubscribe = selected === 'mqtt' || selected === 'mqtts';
  // Every OTHER transport carries attributes too since 2026-10-28 (operator:
  // "add for all protocals") — in its own terms, never as an MQTT topic: HTTP
  // reads by GET (it cannot push), WS / TCP send {"subscribe":"attributes"} on
  // the connection they already hold and get the set, then every change.
  const isHttp = selected === 'http' || selected === 'https';
  const sampleDevice = isGateway ? bundleChildren[0] : code;
  const socketFrame = JSON.stringify({ device: sampleDevice, attributes: sampleAttributes, changed: { 'High Temperature Limit': '27' }, ts: sampleTs }, null, 2);
  const httpAnswer = JSON.stringify({
    device: code, attributes: sampleAttributes, ts: sampleTs,
    children: isGateway ? bundleChildren.map((c) => ({ device: c, attributes: sampleAttributes })) : [],
  }, null, 2);
  // Shared head of both one-line commands. `--cafile` stays on MQTTS: without
  // it the client cannot validate the broker and simply refuses to connect.
  const brokerPort = selected === 'mqtts' ? '8883' : '1883';
  const cafile = selected === 'mqtts' ? ' --cafile "<ca-cert.pem>"' : '';
  const pubPrefix = `mosquitto_pub -h <broker-host> -p ${brokerPort}${cafile} -i "${code}"`;
  const subPrefix = `mosquitto_sub -h <broker-host> -p ${brokerPort}${cafile} -i "${code}"`;

  // A gateway sends ONE batch payload keyed by each child's code, not the
  // single-reading body an ordinary instrument sends. When there are no
  // linked children yet there is no correct payload to show — a placeholder
  // device map would be a lie a technician could paste and "succeed" with.
  const hasChildren = isGateway && (childCodes?.length ?? 0) > 0;
  // A LIST of blocks, each naming its instrument under the common key `devN`
  // (operator, 2026-09-05: "devN is common key for all, value will change").
  // The server also still accepts the older code-keyed object
  // (`"<code>": {...}`); this is the shape the plant's gateway firmware sends,
  // so it is the one shown.
  const devices = hasChildren
    ? {
        devices: (childCodes as string[]).map((c) => ({ devN: c, t: 21.5, h: 47 })),
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
    const credentialRows = <CredentialRows token={tok} clientId={code} showClientId={showClientId} />;

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
                  : `curl -k -X POST ${httpUrl} \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"t": 21.5, "h": 47}'`
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
            <CodeBlock text={`${pubPrefix} -t "${topic}" -u "${tok}" -P "" -m '${isGateway ? compactDevicesPayload : '{"t": 21.5, "h": 47}'}'`} />
            {/* The plant's firmware publishes ONE CHILD PER MESSAGE — a flat
                payload naming the child under `devN` — on this same topic.
                Shown beside the batch so a technician sees both accepted forms. */}
            {isGateway && hasChildren && (
              <>
                <Row label="One child per message" value={topic} />
                <CodeBlock text={`${pubPrefix} -t "${topic}" -u "${tok}" -P "" -m '${JSON.stringify({ devN: (childCodes as string[])[0], t: 21.5, h: 47 })}'`} />
              </>
            )}
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
              text={`const ws = new WebSocket("${wsUrl}", {\n  headers: { Authorization: "Bearer ${tok}" },\n});\nws.on("open", () => ws.send(JSON.stringify(${isGateway ? devicesPayload : '{ t: 21.5, h: 47 }'})));`}
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
                  : `{"token":"${tok}"}\n{"t": 21.5, "h": 47}\n{"t": 21.7, "h": 46}`
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
      <div className="seg flex-wrap" role="tablist" aria-label="Protocol">
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
              className="seg-btn"
            >
              {t.toUpperCase()}
              {/* One amber, not two: the selected tab used to be a dark slate
                  chip and needed a lighter dot to stay visible on it. It is a
                  white chip now, so the same amber works on both states. */}
              {!isLive && (
                <span
                  aria-hidden="true"
                  className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-amber-500 align-middle"
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
      {!canSubscribe && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3" data-testid="attributes-non-mqtt">
          <p className="text-sm font-medium text-slate-700">Attribute updates (platform → device)</p>
          {isHttp ? (
            <>
              <Row label="Read" value={`GET ${attributesUrl}`} />
              <CodeBlock text={`curl -k ${attributesUrl} \\\n  -H "Authorization: Bearer ${tok}"`} />
              <Row label="Delivery" value="on request — HTTP cannot push; GET again to see a change" />
              <CodeBlock text={httpAnswer} />
            </>
          ) : (
            <>
              <Row label="Subscribe" value={`send {"subscribe":"attributes"} after the token`} />
              <CodeBlock text={selected === 'tcp' ? '{"subscribe":"attributes"}' : 'ws.send(JSON.stringify({ subscribe: "attributes" }));'} />
              <Row label="Delivery" value={isGateway ? 'the current set now — one message per instrument, its own and each child\'s — then every change' : 'the current set now, then every change'} />
              <CodeBlock text={socketFrame} />
            </>
          )}
          <p className="pt-2 text-sm font-medium text-slate-700">Attribute report (device → platform)</p>
          {isHttp ? (
            <>
              <Row label="Endpoint" value={`POST ${attributesUrl}`} />
              <CodeBlock text={`curl -k -X POST ${attributesUrl} \\\n  -H "Authorization: Bearer ${tok}" \\\n  -H "Content-Type: application/json" \\\n  -d '${reportPayload}'`} />
            </>
          ) : (
            <CodeBlock text={selected === 'tcp' ? JSON.stringify({ attributes: JSON.parse(reportPayload) }) : `ws.send(JSON.stringify(${JSON.stringify({ attributes: JSON.parse(reportPayload) })}));`} />
          )}
        </div>
      )}
      {canSubscribe && (
        <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3">
          <p className="text-sm font-medium text-slate-700">Attribute updates (platform → device)</p>
          <Row label="Attributes topic" value={attributeTopic} />
          <CodeBlock text={`${subPrefix} -t "${attributeTopic}" -u "${tok}" -P "" -v`} />
          {/* The payload each slot carries — retained, so a device gets it on
              subscribe, whenever the change happened. */}
          <Row label="Attributes payload" value={isGateway ? `retained, one per child on instruments/${code}/attributes/<child code>` : 'retained'} />
          <CodeBlock text={attributePayload} />
          {bundleTopic && (
            <>
              <Row label="Change topic" value={bundleTopic} />
              <CodeBlock text={`${subPrefix} -t "${bundleTopic}" -u "${tok}" -P "" -v`} />
              <Row label="Change payload" value="on change only, not retained, the changed key only" />
              <CodeBlock text={bundlePayload} />
            </>
          )}
          {rosterTopic && (
            <>
              <Row label="Children topic" value={rosterTopic} />
              <CodeBlock text={`${subPrefix} -t "${rosterTopic}" -u "${tok}" -P "" -v`} />
              <Row label="Children payload" value="retained, membership" />
              <CodeBlock text={rosterPayload} />
            </>
          )}
          {/* The other direction (2026-09-05): the device PUBLISHES attribute
              values here, in the telemetry batch's shape. Which keys it may
              write is administered (Configuration → Instrument Attributes). */}
          <p className="pt-2 text-sm font-medium text-slate-700">Attribute report (device → platform)</p>
          <Row label="Report topic" value={reportTopic} />
          <CodeBlock text={`${pubPrefix} -t "${reportTopic}" -u "${tok}" -P "" -m '${reportPayload}'`} />
          {/* RTC sync (2026-09-05): the gateway asks on its own topic and
              reads the time on the GLOBAL one — which also ticks every 10 minutes,
              asked or not. Gateways only: they hold the connection. */}
          {isGateway && (
            <>
              <p className="pt-2 text-sm font-medium text-slate-700">RTC sync</p>
              <Row label="Request topic" value={`instruments/${code}/rtc-request`} />
              <CodeBlock text={`${pubPrefix} -t "instruments/${code}/rtc-request" -u "${tok}" -P "" -m '{"method":"getTime"}'`} />
              <Row label="Time topic" value="digilog/rtc/time" />
              <CodeBlock text={`${subPrefix} -t "digilog/rtc/time" -u "${tok}" -P "" -v`} />
              <Row label="Time payload" value="{&quot;unix&quot;: epoch milliseconds} — on request, and every 10 minutes (:00, :10, :20 …)" />
              <CodeBlock text={JSON.stringify({ unix: new Date(sampleTs).getTime() })} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
