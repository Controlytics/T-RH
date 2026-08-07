import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import { prisma } from '../../../lib/prisma.js';
import type { IngestIdentity } from '../ingest-auth.js';
import { ingestPayload } from '../ingest-core.js';

/**
 * MQTT ingest bridge — subscribes `instruments/+/telemetry` on an EXTERNAL
 * broker (EMQX) and hands every message to the shared ingest core.
 *
 * WHY AN EXTERNAL BROKER: an embedded one would have to hold device
 * credentials, so a revoked token would keep working until whatever cache or
 * sync interval caught up. EMQX holds nothing and calls
 * `POST /api/ingest/v1/mqtt-auth` at each CONNECT instead.
 *
 * ─── AUTHORISATION: read this before changing anything here ─────────────────
 * This bridge is a SUBSCRIBER. MQTT delivers a topic and a payload and does not
 * tell a subscriber which client published — so the bridge CANNOT check that
 * the publisher was entitled to `instruments/<code>/telemetry`, and it does not
 * pretend to. Entitlement is enforced at the broker, by two legs that only work
 * together:
 *
 *   1. `mqtt-auth-routes.ts` refuses a CONNECT whose `clientid` is not the
 *      resolved instrument's `code`.
 *   2. EMQX `etc/acl.conf` permits publish only to
 *      `instruments/${clientid}/telemetry`, with `authorization.no_match = deny`.
 *
 * If either leg is removed — including by flipping `no_match` back to EMQX's
 * permissive default — any device with a valid token can write any
 * instrument's telemetry, and nothing in this file will notice. The bridge
 * DEPENDS on that broker configuration; it is not defence in depth.
 *
 * Resolving the instrument BY CODE here is therefore not a second credential
 * path: no credential is presented to a subscriber to check. The token check
 * happened at CONNECT, and `resolveInstrumentByToken` remains the only place a
 * token is ever validated.
 */

/**
 * A real byte check on the payload handed to the core, BEFORE any parse.
 * Matches the HTTP route's `BODY_LIMIT_BYTES` (`ingest-routes.ts`) for the
 * reason recorded there: `MAX_KEYS` in `ingest-core.ts` bounds the FLAT path
 * only, so on a gateway BATCH this cap is the only thing between a device and
 * `writeBatch`'s Postgres bind-parameter ceiling (5 params per reading against
 * 65535 per statement = 13_107 readings; the smallest reading inside a device
 * block is `"k":1,` = 6 bytes, so 65_536 bytes buys at most ~10_922).
 *
 * Neither `mqtt.js` nor the broker supplies this: the client library imposes no
 * per-message limit at all, and EMQX's `max_packet_size` (1 MB by default) is a
 * protocol guard an operator can raise without ever reading this file.
 */
const DEFAULT_MAX_MESSAGE_BYTES = 65_536;

/**
 * Messages accepted while an earlier one is still being written. Processing is
 * serialised — one shared connection carries every device, so concurrent
 * `ingestPayload` calls would let one chatty publisher exhaust the connection
 * pool.
 *
 * A DROP HERE IS DATA LOSS, not back-pressure. `mqtt.js` PUBACKs a QoS 1
 * message on receipt unless the client is created with `manualAcks`, so by the
 * time this queue is consulted the broker already considers the message
 * delivered and will never redeliver it. Hence the loud log. Making these
 * drops recoverable means `manualAcks` plus acking only after the write — a
 * real design change, not a tweak.
 */
const DEFAULT_MAX_QUEUED = 500;

/** Reconnect backoff. Capped so a broker outage does not become a hot loop. */
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

export const TELEMETRY_TOPIC_FILTER = 'instruments/+/telemetry';

export interface MqttBridgeOptions {
  /** Injected in tests to keep the run quiet; defaults to console. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  maxMessageBytes?: number;
  maxQueued?: number;
  /** Merged over the defaults — the bridge's OWN broker credentials, TLS, etc. */
  clientOptions?: IClientOptions;
}

export interface MqttBridgeHandle {
  close(): Promise<void>;
  /**
   * Publish on the bridge's connection. The DOWNLINK path (attribute changes
   * out to devices) — the only thing this bridge ever publishes.
   *
   * Resolves on the broker's acknowledgement, rejects on a publish error, and
   * imposes no timeout of its own: bounding the wait is the caller's job, and
   * `attribute-downlink.ts` does it. This deliberately does NOT check
   * `client.connected` first — `mqtt.js` queues an offline QoS 1 publish, and a
   * check here would only move the race one line earlier.
   *
   * The broker must permit it: `etc/acl.conf` grants the bridge's username
   * publish on `instruments/+/attributes` and `instruments/+/attributes/+`.
   * Without those rules the publish is denied and, with
   * `deny_action = disconnect`, takes the ingest subscription down with it.
   */
  publish(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>;
  /** Exposed for tests and health checks; never used for control flow. */
  readonly client: MqttClient;
}

/**
 * `instruments/<id>/telemetry` -> `<id>`, or null.
 *
 * The segment is the instrument's UUID, not its code, since 2026-08-07: the
 * code became free text (any character, any length) and a code containing `/`,
 * `+` or `#` would forge a topic shape or match the broker's ACL against every
 * instrument. A platform-generated UUID cannot.
 *
 * Pure, and separately tested: a topic router that is loose about segment count
 * is how `instruments/A/B/telemetry` ends up filed against instrument "A". The
 * exact-three-segment split is what keeps a longer topic from being accepted as
 * a shorter one.
 */
export function parseTelemetryTopic(topic: string): string | null {
  const parts = topic.split('/');
  if (parts.length !== 3) return null;
  if (parts[0] !== 'instruments' || parts[2] !== 'telemetry') return null;
  return parts[1].length > 0 ? parts[1] : null;
}

/** mqtt.js transports that encrypt. Anything else puts the credential on the wire. */
const ENCRYPTED_BROKER_SCHEMES = new Set(['mqtts:', 'wss:', 'tls:', 'ssl:']);

/**
 * RFC 6761: `localhost` and any `*.localhost` name resolve to a loopback
 * address, so the hostname form must be handled and not just the literals — on
 * Windows `localhost` resolves to `::1` FIRST, which is exactly the asymmetry
 * that made the EMQX authenticator fail with `econnrefused` when it was pointed
 * at `localhost` against an IPv4-only bind.
 *
 * The whole 127.0.0.0/8 block is loopback, not merely 127.0.0.1.
 */
function isLoopbackHost(hostname: string): boolean {
  // `new URL('mqtt://[::1]:1883').hostname` keeps the brackets.
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/**
 * The bridge's subscription hop is deliberately PLAINTEXT while the broker is on
 * loopback: what crosses it is the bridge's own static broker credential, never
 * a device token, and it never reaches a network. That decision is recorded in
 * `apps/api/.env.example` and `LOCAL_SETUP_WINDOWS.md` §9B.
 *
 * The decision stops holding the instant the broker is somewhere else, and until
 * this check existed that failure was SILENT: an operator edits a URL, the
 * scheme stays `mqtt://`, the credential starts crossing a real network in the
 * clear, and nothing anywhere says so. A comment in `.env` does not survive
 * contact with someone editing a URL.
 *
 * Returns the warning text, or null when the hop is fine. Deliberately a pure
 * function returning a string rather than something that logs or throws: it
 * makes every branch testable without a broker, and it keeps the WARN-don't-
 * refuse choice in the caller's hands. Booting is not blocked — pointing at a
 * LAN broker on purpose is legitimate, and refusing to start over a config
 * preference would be the wrong trade.
 */
export function plaintextRemoteBrokerWarning(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Cannot prove it is loopback, so say so rather than stay quiet. This URL
    // will fail to connect anyway and the bridge will complain separately.
    return `MQTT_BROKER_URL is not a parseable URL (${url}) — cannot verify whether the bridge's broker credential stays on this machine. Expected e.g. mqtt://127.0.0.1:1883`;
  }

  if (ENCRYPTED_BROKER_SCHEMES.has(parsed.protocol)) return null;
  if (isLoopbackHost(parsed.hostname)) return null;

  return (
    `MQTT_BROKER_URL points at a REMOTE broker over PLAINTEXT (${parsed.protocol}//${parsed.host}) — ` +
    `the bridge's own broker credential (MQTT_USERNAME / MQTT_PASSWORD) crosses the network in the clear ` +
    `on every connect and can be captured and replayed by anyone on the path. ` +
    `Use mqtts:// (and give the bridge a CA — app.ts forwards only username/password today, so that needs code), ` +
    `or keep the broker on loopback. ` +
    `This is the API's OWN subscription hop; devices publishing over mqtts on 8883 are unaffected.`
  );
}

/**
 * Starts unconditionally against the URL it is handed. The `MQTT_BROKER_URL`
 * gate lives in `app.ts`, not here, so a test can point one at a local broker
 * without mutating `process.env`.
 */
export async function startMqttBridge(
  url: string,
  opts: MqttBridgeOptions = {},
): Promise<MqttBridgeHandle> {
  const maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
  const log = opts.log ?? ((msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[ingest:mqtt] ${msg}`, meta ?? ''));

  const client = mqtt.connect(url, {
    // The bridge's own identity on the broker, distinct from any device. EMQX
    // must be configured to admit it (a built-in-database authenticator ahead
    // of the HTTP one) — it presents no instrument token, so the device hook
    // would rightly deny it.
    //
    // STABLE across restarts, deliberately: with `clean: false` the session —
    // and anything the broker queued while we were down — is keyed on this id,
    // so putting the pid in it would start a fresh session on every restart,
    // strand the old one until `session_expiry_interval`, and quietly discard
    // exactly the messages the durable session exists to preserve. The topic
    // ACL grants subscribe by USERNAME, not client id, so this is not an
    // authorisation input. Single-instance deployment; if that ever changes,
    // give each instance its own MQTT_CLIENT_ID (two clients sharing one id
    // kick each other off in a loop).
    clientId: process.env.MQTT_CLIENT_ID || 'digilog-ingest-bridge',
    reconnectPeriod: RECONNECT_MIN_MS,
    // Redelivery of anything published while we were down is the whole reason
    // for QoS 1; a clean session would throw it away at reconnect.
    clean: false,
    resubscribe: true,
    ...opts.clientOptions,
  });

  let backoff = RECONNECT_MIN_MS;
  let closing = false;

  const queue: Array<{ topic: string; payload: Buffer }> = [];
  let draining = false;

  client.on('connect', () => {
    backoff = RECONNECT_MIN_MS;
    client.options.reconnectPeriod = RECONNECT_MIN_MS;
    log('connected to broker', { url });
    client.subscribe(TELEMETRY_TOPIC_FILTER, { qos: 1 }, (err) => {
      if (err) {
        // LOUD: a bridge that is connected but not subscribed looks healthy
        // from every angle while telemetry vanishes with no error anywhere.
        log('SUBSCRIBE FAILED — no telemetry will be received', {
          topic: TELEMETRY_TOPIC_FILTER, err: err.message,
        });
      } else {
        log('subscribed', { topic: TELEMETRY_TOPIC_FILTER, qos: 1 });
      }
    });
  });

  // Every one of these is logged at warn or above, deliberately. A silently
  // dead bridge is worse than a crash: devices publish happily, the broker
  // accepts, and nothing reaches the database until someone notices a gap in
  // the readings days later.
  client.on('reconnect', () => {
    log('reconnecting to broker — telemetry is NOT being ingested', { url, nextDelayMs: backoff });
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    client.options.reconnectPeriod = backoff;
  });
  client.on('offline', () => {
    if (!closing) log('OFFLINE — telemetry is NOT being ingested', { url });
  });
  client.on('close', () => {
    if (!closing) log('connection to broker closed', { url });
  });
  client.on('error', (err) => {
    // Never rethrown: an unhandled 'error' on the client is a process-level
    // crash, and a broker being unreachable must not take the API down.
    log('client error', { url, err: err.message });
  });

  client.on('message', (topic: string, payload: Buffer) => {
    if (closing) return;

    // BEFORE the parse and before the topic lookup — a real byte check on the
    // buffer that would be handed to the core. See DEFAULT_MAX_MESSAGE_BYTES.
    if (payload.byteLength > maxMessageBytes) {
      log('message dropped — exceeds the byte cap', {
        topic, cap: maxMessageBytes, size: payload.byteLength,
      });
      return;
    }

    if (queue.length >= maxQueued) {
      // LOST, not deferred — see DEFAULT_MAX_QUEUED. The broker has already
      // been acked for this message.
      log('message LOST — publishing faster than readings can be written', {
        topic, queued: queue.length,
      });
      return;
    }

    queue.push({ topic, payload });
    void drain();
  });

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (queue.length > 0 && !closing) {
        const { topic, payload } = queue.shift() as { topic: string; payload: Buffer };

        const instrumentId = parseTelemetryTopic(topic);
        if (!instrumentId) {
          log('message dropped — topic does not match instruments/<id>/telemetry', { topic });
          continue;
        }

        const identity = await lookupById(instrumentId);
        if (!identity) {
          // Dropped, not dead-lettered: a dead-letter is filed AGAINST an
          // instrument, and there is no instrument here to file it against.
          // Inventing one would be a fabricated record in a §11 system, and
          // auto-creating from a payload is forbidden on every transport.
          log('message dropped — no active instrument with that id', { topic, instrumentId });
          continue;
        }

        try {
          const outcome = await ingestPayload({ identity, raw: payload, transport: 'mqtt' });
          // A refusal means the core RECORDED the problem correctly (UNPARSEABLE
          // and NOT_A_GATEWAY are both dead-lettered in there). There is no
          // connection to drop here anyway — one bad message from one device
          // must not disturb the shared subscription.
          if (!outcome.ok) log('reading refused', { code: outcome.code, instrument: identity.code });
        } catch (e) {
          // A throw out of ingestPayload (a DB outage, say) must not become an
          // unhandled rejection and must not stop the queue: the next message
          // may be from a different device entirely.
          log('ingest failed', { topic, err: (e as Error).message });
        }
      }
    } finally {
      draining = false;
    }
  }

  await new Promise<void>((resolve) => {
    // Resolves on the FIRST connect, but never rejects and is not awaited
    // forever: a broker that is down at boot must not block API startup, and
    // mqtt.js will keep retrying in the background.
    const t = setTimeout(() => resolve(), 3_000);
    t.unref();
    client.once('connect', () => { clearTimeout(t); resolve(); });
  });

  return {
    client,
    publish: (topic, payload, publishOpts) =>
      new Promise<void>((resolve, reject) => {
        // Refuse once we are shutting down rather than handing mqtt.js a
        // publish on a client that is being torn down — `client.end(true, …)`
        // discards the outgoing store, so the callback would never fire and the
        // caller would wait out its whole timeout for a message that was never
        // going to leave.
        if (closing) return reject(new Error('bridge is closing'));
        client.publish(topic, payload, publishOpts, (err) =>
          err ? reject(err) : resolve());
      }),
    close: () =>
      new Promise<void>((resolve) => {
        closing = true;
        client.end(true, {}, () => resolve());
      }),
  };
}

/**
 * The instrument named by the topic. Not a credential check — see the header:
 * the token was checked by EMQX at CONNECT via our hook, and the broker's ACL
 * is what ties this topic to that token.
 *
 * One query per message. Deliberate: a stale cache here would keep accepting
 * readings for an instrument an operator has just deactivated, and the write
 * that follows costs far more than this lookup.
 */
async function lookupById(id: string): Promise<IngestIdentity | null> {
  // A malformed segment is a miss, not a 500: Prisma throws on a non-UUID for a
  // uuid column, and a device publishing garbage must be dropped like any other
  // unknown instrument rather than taking the drain loop down.
  if (!UUID_RE.test(id)) return null;
  const inst = await prisma.instrument.findUnique({
    where: { id },
    select: { id: true, code: true, isGateway: true, isActive: true },
  });
  if (!inst || !inst.isActive) return null;
  return { id: inst.id, code: inst.code, isGateway: inst.isGateway };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
