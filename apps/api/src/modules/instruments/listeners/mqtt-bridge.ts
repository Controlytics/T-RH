import mqtt, { type MqttClient, type IClientOptions } from 'mqtt';
import { prisma } from '../../../lib/prisma.js';
import type { IngestIdentity } from '../ingest-auth.js';
import { ingestPayload } from '../ingest-core.js';
import { ingestAttributeReport } from '../attribute-report.js';
import { parseRtcRequestTopic, isGetTimeRequest, publishTime } from './rtc-sync.js';
import { logger } from '../../../lib/logger.js';

/**
 * MQTT ingest bridge — subscribes `instruments/#` on an EXTERNAL broker
 * (EMQX) and hands every `instruments/<code>/telemetry` message to the shared
 * ingest core.
 *
 * `#`, not `+`, since 2026-09-04: the segment is the instrument CODE and codes
 * at this plant are `CWH/RDU/001-00` — three levels, which `+` (exactly one
 * level) can never match. The wider filter also delivers the bridge's OWN
 * retained downlinks (`…/attributes`, `…/children`); `isDownlinkTopic` drops
 * those silently before the telemetry parse is even attempted.
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
 *      resolved instrument's `code` (the UUID between 2026-08-07 and
 *      2026-09-04; the code again at the operator's request — see that file).
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

/**
 * Reconnect period. FLAT, and that is a fact about mqtt.js rather than a
 * choice made here: the client arms ONE `setInterval(options.reconnectPeriod)`
 * on the first close after a disconnect and re-reads the option only after the
 * NEXT SUCCESSFUL CONNECT — `_setupReconnect` is a no-op while `reconnectTimer`
 * is set, and `_clearReconnect` runs on CONNACK, on `end()` and nowhere on a
 * failed attempt (verified in `node_modules/mqtt` 5.15.2,
 * `build/lib/client.js`, audit 2026-10-03 INGEST-18). Until that audit this
 * file doubled `client.options.reconnectPeriod` on every 'reconnect' event
 * and called it a capped backoff: the mutation was never read, every retry
 * was one second apart, and the comment was false. One TCP connect a second
 * against a down broker is not a hot loop; the cost is the warn line per
 * attempt, and `reconnectLogDue` throttles THAT instead of pretending to
 * throttle the attempts.
 */
const RECONNECT_PERIOD_MS = 1_000;
/** Log the first attempt and then one in every N — about once a minute at the period above. */
export const RECONNECT_LOG_EVERY = 60;

/** Pure: is this reconnect attempt one that gets a log line? */
export function reconnectLogDue(attempt: number): boolean {
  return attempt === 1 || attempt % RECONNECT_LOG_EVERY === 0;
}

export const TELEMETRY_TOPIC_FILTER = 'instruments/#';

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
   * publish on `instruments/#` (it was `instruments/+/attributes` and
   * `instruments/+/attributes/+` while the segment was a UUID; a code carries
   * slashes, so `+` no longer reaches it). Without that rule the publish is
   * denied and, with `deny_action = disconnect`, takes the ingest subscription
   * down with it.
   */
  publish(topic: string, payload: string, opts: { qos: 0 | 1 | 2; retain: boolean }): Promise<void>;
  /** Exposed for tests and health checks; never used for control flow. */
  readonly client: MqttClient;
}

export type PublishDisposition = 'publish' | 'reject-closing' | 'reject-offline-event' | 'queue-offline-retained';

/**
 * What to do with a publish, by connection state and message kind. Pure, so
 * the rule is testable without a broker; `publish()` below is a switch over it.
 *
 *  - closing → refuse: `client.end(true)` discards the outgoing store, so the
 *    callback would never fire and the caller would wait out its timeout.
 *  - offline EVENT → refuse (2026-09-05): mqtt.js would queue it and flush it
 *    on reconnect, and a gateway setting its clock from a two-minute-old tick
 *    would be wrong. A stale event is worse than none.
 *  - offline RETAINED → QUEUE and resolve at once (2026-09-16): retained state
 *    MAY wait for the reconnect — mqtt.js stores a QoS 1 publish and sends it
 *    then — but the callback fires only on PUBACK, so awaiting it made every
 *    downlink wait out `attribute-downlink.ts`'s 2 s timeout per message while
 *    the broker was down. A profile-key cascade of 400 removals held its HTTP
 *    response for ~27 minutes that way. Resolving on QUEUE is honest: the
 *    database is the record, the slot will be current when the broker returns,
 *    and nothing on the wire was ever going to happen sooner.
 */
export function publishDisposition(s: { retain: boolean; connected: boolean; closing: boolean }): PublishDisposition {
  if (s.closing) return 'reject-closing';
  if (!s.connected && !s.retain) return 'reject-offline-event';
  if (!s.connected) return 'queue-offline-retained';
  return 'publish';
}

const TELEMETRY_PREFIX = 'instruments/';
const TELEMETRY_SUFFIX = '/telemetry';
/** The device → platform ATTRIBUTE path (2026-09-05): `instruments/<code>/attributes/report`. */
const ATTRIBUTE_REPORT_SUFFIX = '/attributes/report';

/**
 * `instruments/<code>/attributes/report` → `<code>`, or null. Checked BEFORE
 * `isDownlinkTopic`, which would otherwise swallow it as one of the bridge's own
 * retained slots (it contains `/attributes/`). A code ending in `report` WAS
 * refused at registration (2026-09-04 → 2026-09-16, `MQTT_RESERVED_TOPIC_SEGMENTS`);
 * the operator removed that guard, so a child coded `X/report` can now exist and
 * its per-child downlink `instruments/<gw>/attributes/X/report` would be read
 * here as a report from `<gw>/attributes/X`. Known and accepted, not a defect.
 */
export function parseAttributeReportTopic(topic: string): string | null {
  if (topic.length <= TELEMETRY_PREFIX.length + ATTRIBUTE_REPORT_SUFFIX.length) return null;
  if (!topic.startsWith(TELEMETRY_PREFIX) || !topic.endsWith(ATTRIBUTE_REPORT_SUFFIX)) return null;
  const code = topic.slice(TELEMETRY_PREFIX.length, topic.length - ATTRIBUTE_REPORT_SUFFIX.length);
  if (code.length === 0 || code.includes('+') || code.includes('#')) return null;
  return code;
}

/**
 * `instruments/<code>/telemetry` -> `<code>`, or null.
 *
 * The segment is the instrument's CODE again (2026-09-04) and a code may
 * contain slashes — `CWH/RDU/001-00` is the plant's shape — so this matches a
 * FIXED PREFIX and SUFFIX and takes everything between them verbatim, rather
 * than splitting on `/` and counting. `instruments/A/B/telemetry` is therefore
 * the instrument coded `A/B`, exactly as the broker's ACL template
 * `instruments/${clientid}/telemetry` addressed it.
 *
 * This is unambiguous only while no code's LAST segment is
 * `telemetry`/`attributes`/`children`. That was guaranteed at registration
 * from 2026-09-04 to 2026-09-16 (`instrumentCodeTopicViolation`); the operator
 * removed the guard ("remove instrument id restriction"), so a child coded
 * `X/telemetry` CAN now have its attribute downlink published on
 * `instruments/<gw>/attributes/X/telemetry`, which this function reads as
 * telemetry from `<gw>/attributes/X`. Known and accepted, not a defect.
 *
 * Pure, and separately tested.
 */
export function parseTelemetryTopic(topic: string): string | null {
  if (topic.length <= TELEMETRY_PREFIX.length + TELEMETRY_SUFFIX.length) return null;
  if (!topic.startsWith(TELEMETRY_PREFIX) || !topic.endsWith(TELEMETRY_SUFFIX)) return null;
  const code = topic.slice(TELEMETRY_PREFIX.length, topic.length - TELEMETRY_SUFFIX.length);
  if (code.length === 0) return null;
  // Registration refuses these and a broker refuses a publish carrying them;
  // the router must not be the layer that relies on either.
  if (code.includes('+') || code.includes('#')) return null;
  return code;
}

/**
 * One of the three retained slots the bridge ITSELF publishes:
 * `instruments/<code>/attributes`, `instruments/<gw>/attributes/<child>`,
 * `instruments/<gw>/children`. Subscribing `instruments/#` hands these back to
 * the bridge on every (re)subscribe and after every downlink, and they are
 * dropped SILENTLY — a "dropped" log line per retained slot per reconnect
 * would bury a real drop.
 *
 * The telemetry SUFFIX decides, here as well as in the bridge's check order: a
 * code may carry `attributes` in a middle segment, and
 * `instruments/X/attributes/Y/telemetry` is telemetry from `X/attributes/Y`,
 * never a downlink. Encoded in the function rather than left to the caller so
 * a reordering of the two checks cannot silently swallow readings.
 */
export function isDownlinkTopic(topic: string): boolean {
  if (!topic.startsWith(TELEMETRY_PREFIX)) return false;
  if (topic.endsWith(TELEMETRY_SUFFIX)) return false;
  return topic.endsWith('/attributes') || topic.includes('/attributes/') || topic.endsWith('/children');
}

/**
 * A message that is the bridge's OWN retained publish coming back to it, and
 * nothing else: a downlink slot that is NOT a device's attribute report (which
 * also sits under `/attributes/` and must win — the same precedence the drain
 * applies). Pure, so the `message` handler can apply it SYNCHRONOUSLY before
 * a queue slot is taken (audit 2026-10-03, INGEST-7): one retained slot per
 * instrument, one per child, one roster per gateway — about 200 on this plant
 * — are all re-delivered on every (re)subscribe, and until then they counted
 * against `maxQueued`, so a reconnect's burst pushed real readings past the
 * cap and the log blamed "publishing faster than readings can be written" for
 * what was a reconnect.
 */
export function isBridgeEcho(topic: string): boolean {
  return parseAttributeReportTopic(topic) === null && isDownlinkTopic(topic);
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
    logger.warn(`[ingest:mqtt] ${msg}`, meta ?? ''));

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
    reconnectPeriod: RECONNECT_PERIOD_MS,
    // Redelivery of anything published while we were down is the whole reason
    // for QoS 1; a clean session would throw it away at reconnect.
    clean: false,
    resubscribe: true,
    ...opts.clientOptions,
  });

  /** Attempts since the last successful connect; drives `reconnectLogDue`. */
  let reconnectAttempts = 0;
  let closing = false;

  const queue: Array<{ topic: string; payload: Buffer }> = [];
  let draining = false;

  client.on('connect', () => {
    log('connected to broker', { url, afterAttempts: reconnectAttempts });
    reconnectAttempts = 0;
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
    // Nothing here touches `client.options.reconnectPeriod` — mqtt.js would
    // not read it (see RECONNECT_PERIOD_MS). The attempt count is what is
    // throttled, so a day-long outage is ~1,440 lines, not 86,400.
    reconnectAttempts++;
    if (reconnectLogDue(reconnectAttempts)) {
      log('reconnecting to broker — telemetry is NOT being ingested', {
        url, attempt: reconnectAttempts, periodMs: RECONNECT_PERIOD_MS,
      });
    }
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

    // The bridge's own retained slots echoed back under `instruments/#` are
    // dropped HERE, synchronously, before they can take a queue slot — see
    // `isBridgeEcho`. Silently: a line per slot per reconnect would bury a
    // real drop.
    if (isBridgeEcho(topic)) return;

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

        // RTC request (2026-09-05): `{"method":"getTime"}` on
        // `instruments/<code>/rtc-request` → the time goes out on the GLOBAL
        // time topic at once. Any active instrument may ask; anything else on
        // the topic is ignored, and an unknown code is dropped with a log.
        const rtcCode = parseRtcRequestTopic(topic);
        if (rtcCode) {
          const asker = await lookupByCode(rtcCode);
          if (!asker) {
            log('rtc request dropped — no active instrument with that code', { topic, code: rtcCode });
          } else if (!isGetTimeRequest(payload)) {
            log('rtc request ignored — not {"method":"getTime"}', { instrument: asker.code });
          } else {
            await publishTime(new Date(), log);
          }
          continue;
        }

        // Attribute REPORT first — see `parseAttributeReportTopic` for why it
        // must precede the downlink check.
        const reportCode = parseAttributeReportTopic(topic);
        if (reportCode) {
          const reporter = await lookupByCode(reportCode);
          if (!reporter) {
            log('attribute report dropped — no active instrument with that code', { topic, code: reportCode });
            continue;
          }
          try {
            const outcome = await ingestAttributeReport({ identity: reporter, raw: payload, log });
            if (!outcome.ok) log('attribute report refused', { code: outcome.code, instrument: reporter.code });
            else if (outcome.refused > 0) log('attribute report: keys refused', { instrument: reporter.code, refused: outcome.refused });
          } catch (e) {
            log('attribute report FAILED — not written', { instrument: reporter.code, err: (e as Error).message });
          }
          continue;
        }

        const code = parseTelemetryTopic(topic);
        if (!code) {
          // Our own retained downlinks never reach the queue (`isBridgeEcho`
          // in the message handler); this guard stays so a reordering there
          // cannot turn them into a logged drop apiece.
          if (!isDownlinkTopic(topic)) {
            log('message dropped — topic does not match instruments/<code>/telemetry', { topic });
          }
          continue;
        }

        const identity = await lookupByCode(code);
        if (!identity) {
          // Dropped, not dead-lettered: a dead-letter is filed AGAINST an
          // instrument, and there is no instrument here to file it against.
          // Inventing one would be a fabricated record in a §11 system, and
          // auto-creating from a payload is forbidden on every transport.
          log('message dropped — no active instrument with that code', { topic, code });
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
        // The rule lives in `publishDisposition` (pure, tested); this is the switch.
        switch (publishDisposition({ retain: publishOpts.retain, connected: client.connected !== false, closing })) {
          case 'reject-closing':
            return reject(new Error('bridge is closing'));
          case 'reject-offline-event':
            return reject(new Error('bridge offline — event not queued'));
          case 'queue-offline-retained':
            // Handed to mqtt.js's outgoing store; delivered on reconnect. Resolve
            // NOW — see `publishDisposition` — and only log a later refusal.
            client.publish(topic, payload, publishOpts, (err) => {
              if (err) log('queued retained publish was refused on reconnect', { topic, err: err.message });
            });
            log('broker offline — retained publish queued for reconnect', { topic });
            return resolve();
          case 'publish':
            client.publish(topic, payload, publishOpts, (err) =>
              err ? reject(err) : resolve());
        }
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
 *
 * REVOCATION ON AN OPEN MQTT SESSION (audit 2026-10-12): deactivate and delete
 * take effect on the NEXT message through this per-message lookup. A TOKEN
 * change does NOT — the bridge cannot see which credential a publisher used,
 * and EMQX consults the auth hook only at CONNECT — and neither does a CODE
 * reassigned to another instrument while the old device's session (client id
 * = the old code) is still connected: its messages arrive on the new owner's
 * topic and are attributed to it. Closing either gap needs the broker to drop
 * the session (EMQX REST `DELETE /api/v5/clients/{clientid}`); this project
 * has no EMQX API client or credentials, so it is not done here.
 */
async function lookupByCode(code: string): Promise<IngestIdentity | null> {
  // `code` is a plain unique text column, so any string is a legal lookup and
  // an unknown one is a miss, not a throw — a device publishing garbage is
  // dropped like any other unknown instrument rather than taking the drain
  // loop down.
  const inst = await prisma.instrument.findUnique({
    where: { code },
    select: { id: true, code: true, isGateway: true, isActive: true },
  });
  if (!inst || !inst.isActive) return null;
  return { id: inst.id, code: inst.code, isGateway: inst.isGateway };
}
