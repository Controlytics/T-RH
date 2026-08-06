/**
 * Attribute DOWNLINK — the first platform→device path in this codebase.
 *
 * Everything before this was uplink: devices publish, we ingest. The design spec
 * (`docs/superpowers/specs/2026-08-04-instruments-inbound-ingestion-design.md`
 * §10) listed "Commands *to* devices (downlink/RPC)" as out of scope; this
 * narrows that exclusion to attribute state only. There is still no RPC, no
 * command channel, and no device→platform acknowledgement.
 *
 * ─── WHAT THIS IS NOT ───────────────────────────────────────────────────────
 * It is not a delivery guarantee. The DATABASE is the source of truth for an
 * attribute; the broker is one way of telling a device about it. Every failure
 * here is logged and swallowed — see `publishAttributeDownlink`. An attribute
 * write that succeeded and a message that never left are a normal, expected
 * outcome, and the operator must not be told the write failed because of it.
 */

/** What a route hands over after a committed attribute change. */
export interface AttributeDownlink {
  /** The instrument the attribute belongs to. */
  code: string;
  /** Its gateway's code, when it has one. A child has no broker connection. */
  gatewayCode?: string | null;
  /** The instrument's COMPLETE attribute set after the change. */
  attributes: Record<string, string>;
  /** The key this operation touched. */
  changedKey: string;
  /** Its new value, or `null` when the attribute was REMOVED. */
  changedValue: string | null;
  /** Injected, never `new Date()` in here — a payload whose clock is a hidden
   *  global cannot be asserted on. */
  ts: Date;
}

/**
 * One RETAINED slot per instrument.
 *
 *   standalone            instruments/<code>/attributes
 *   child of a gateway    instruments/<gatewayCode>/attributes/<childCode>
 *
 * Per-instrument topics are load-bearing, not cosmetic. MQTT retains only the
 * LAST message per topic, so a single shared `instruments/<gw>/attributes` slot
 * would mean a reconnecting gateway is handed whichever child changed most
 * recently and silently loses every other child's state.
 *
 * A child is addressed UNDER ITS GATEWAY because it has no broker connection of
 * its own: nothing is subscribed to `instruments/<childCode>/attributes`, so
 * publishing there would retain a message no one will ever read. The gateway
 * subscribes `instruments/<gatewayCode>/attributes/#` and demultiplexes on the
 * last segment.
 *
 * Pure: the gateway-vs-standalone branch is exactly where this goes wrong, and
 * it needs no broker to test.
 */
export function attributeDownlinkTopic(code: string, gatewayCode?: string | null): string {
  return gatewayCode
    ? `instruments/${gatewayCode}/attributes/${code}`
    : `instruments/${code}/attributes`;
}

/** The wire shape. `changed[key] === null` means the attribute was removed. */
export interface AttributeDownlinkPayload {
  attributes: Record<string, string>;
  changed: Record<string, string | null>;
  ts: string;
}

/**
 * State AND delta in one message, because the two readers want different things
 * and only one message survives.
 *
 * A device reconnecting reads the RETAINED message and must be able to
 * reconstruct the whole truth from it alone — hence `attributes`, the complete
 * set. A device that is already connected wants to know what just moved —
 * hence `changed`. Splitting them into two topics would mean a reconnecting
 * device retains one of the two and guesses at the other.
 *
 * A DELETED key is ABSENT from `attributes` and present as `null` in `changed`,
 * in the same message. Both halves of that are the point: the absence is the new
 * truth, the null is what the device needs in order to act on the removal rather
 * than diffing against state it may not have.
 */
export function buildAttributeDownlinkPayload(d: AttributeDownlink): AttributeDownlinkPayload {
  return {
    attributes: d.attributes,
    changed: { [d.changedKey]: d.changedValue },
    ts: d.ts.toISOString(),
  };
}

/**
 * QoS 1 and RETAINED, both deliberate.
 *
 * `retain: true` is what makes a device that was powered off during the change
 * correct on its next connect instead of permanently stale — it is the whole
 * reason `attributes` carries the complete set.
 *
 * QoS 1 because at-most-once (QoS 0) would drop the message on a flaky link
 * with nothing anywhere recording that it did; a duplicate is harmless because
 * the payload is idempotent state, not an increment.
 */
export const DOWNLINK_PUBLISH_OPTIONS = { qos: 1 as const, retain: true };

/**
 * Injected by `app.ts` once the bridge is up. Resolves when the broker has
 * acknowledged, rejects on a publish error.
 */
export type DownlinkPublisher = (
  topic: string,
  payload: string,
  options: typeof DOWNLINK_PUBLISH_OPTIONS,
) => Promise<void>;

/**
 * Module-level, but explicitly RESETTABLE (`setDownlinkPublisher(null)`).
 * `test-helper.ts` builds several apps in one process; a publisher installed by
 * one and never cleared would still be live for the next — the same leak the WS
 * connection counter was rescoped to avoid.
 *
 * Null is the NORMAL state, not an error: with `MQTT_BROKER_URL` unset there is
 * no bridge at all, and attribute edits must behave exactly as they did before
 * this file existed.
 */
let publisher: DownlinkPublisher | null = null;

export function setDownlinkPublisher(fn: DownlinkPublisher | null): void {
  publisher = fn;
}

export function downlinkPublisherConfigured(): boolean {
  return publisher !== null;
}

/**
 * Bound wait for the broker's PUBACK. The timeout is the load-bearing guard,
 * NOT any connected-check: the connection can drop between the check and the
 * acknowledgement, and `mqtt.js` with `clean: false` queues an unacknowledged
 * QoS 1 message indefinitely — which would hang an operator's HTTP request on a
 * broker outage.
 */
const PUBLISH_TIMEOUT_MS = 2_000;

/**
 * Publish one attribute change. NEVER THROWS, NEVER REJECTS.
 *
 * CALL THIS AFTER THE TRANSACTION HAS COMMITTED, never inside it. Publishing
 * first means a rolled-back edit can leave a device holding — and, because the
 * message is retained, permanently re-reading — a change the platform does not
 * have. The database is what an inspector reads; the broker must never be ahead
 * of it.
 *
 * A failure here must not fail the attribute write. The write is already
 * durable by the time we are called; reporting an error to the operator would
 * invite them to retry a change that already landed. So: log loudly, in the
 * same spirit as the bridge's OFFLINE line, and return.
 */
export async function publishAttributeDownlink(
  d: AttributeDownlink,
  log: (msg: string, meta?: Record<string, unknown>) => void = (msg, meta) =>
    console.warn(`[downlink:attributes] ${msg}`, meta ?? ''),
): Promise<void> {
  const fn = publisher;
  // Not a failure and not logged: no broker configured means no downlink, which
  // is the documented behaviour of an install with MQTT_BROKER_URL unset.
  if (!fn) return;

  const topic = attributeDownlinkTopic(d.code, d.gatewayCode);
  const payload = JSON.stringify(buildAttributeDownlinkPayload(d));

  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(topic, payload, DOWNLINK_PUBLISH_OPTIONS),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no PUBACK within ${PUBLISH_TIMEOUT_MS}ms`)), PUBLISH_TIMEOUT_MS);
        // The repo has been bitten twice by a stray handle holding the process
        // open past shutdown (the bridge's boot promise, the bridge close).
        timer.unref();
      }),
    ]);
  } catch (e) {
    // LOUD. The attribute is correct in the database and WRONG on the device,
    // and nothing will retry — a device that missed this stays stale until the
    // next change to the same instrument overwrites the retained slot.
    log('DOWNLINK NOT DELIVERED — the device was not told about this change', {
      topic, key: d.changedKey, err: (e as Error).message,
    });
  } finally {
    clearTimeout(timer);
  }
}
