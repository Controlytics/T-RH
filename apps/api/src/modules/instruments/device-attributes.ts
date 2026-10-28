/**
 * Device attribute exchange on EVERY protocol (2026-10-28, operator: "why
 * attributes topic was not there for http and https" → "add for all
 * protocals"). MQTT has two topics (report, and a retained slot to subscribe
 * to). The others get the same two things in their own terms:
 *
 *   HTTP / HTTPS   POST /api/ingest/v1/attributes  — report
 *                  GET  /api/ingest/v1/attributes  — the current set (poll; HTTP cannot push)
 *   WS / WSS, TCP  {"attributes": {...}}           — report (the MQTT report payload, wrapped)
 *                  {"subscribe": "attributes"}      — the current set now, then every change pushed
 *
 * Reports run `ingestAttributeReport` — one implementation of which keys a
 * device may write, how it is audited, and that an unchanged value writes
 * nothing. Read-backs carry exactly what the MQTT slot carries: the complete
 * set with sensor offsets left out, a gateway's children under their codes.
 */
import { prisma } from '../../lib/prisma.js';
import { offsetKeyTest } from './load-offsets.js';
import { childMapFor } from './gateway-children.js';
import { subscribeAttributes, type AttributeFrame } from './attribute-sessions.js';
import type { IngestIdentity } from './ingest-auth.js';

export type DeviceFrame =
  | { kind: 'attributes'; raw: Buffer }
  | { kind: 'subscribe' }
  | { kind: 'telemetry' };

/**
 * What a WebSocket frame or TCP line IS. Strict on purpose: only a frame whose
 * ONE top-level key is `attributes` with an object value is a report, and only
 * `{"subscribe":"attributes"}` subscribes — a telemetry frame that happens to
 * carry an `attributes` reading beside others stays telemetry, and anything
 * unreadable is telemetry so the ingest core dead-letters it as before.
 */
export function classifyDeviceFrame(raw: Buffer | string): DeviceFrame {
  let parsed: unknown;
  try { parsed = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8')); } catch { return { kind: 'telemetry' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { kind: 'telemetry' };
  const keys = Object.keys(parsed);
  if (keys.length !== 1) return { kind: 'telemetry' };
  const v = (parsed as Record<string, unknown>)[keys[0]];
  if (keys[0] === 'attributes' && v && typeof v === 'object' && !Array.isArray(v)) {
    return { kind: 'attributes', raw: Buffer.from(JSON.stringify(v), 'utf8') };
  }
  if (keys[0] === 'subscribe' && v === 'attributes') return { kind: 'subscribe' };
  return { kind: 'telemetry' };
}

/**
 * The connection's current attribute state: its own set first, then — for a
 * gateway — each linked child's. A child whose profile requires a device
 * certificate is left out unless THIS connection presented the gateway's own
 * (the rule its telemetry already follows). Offsets never reach a device.
 */
export async function attributeSnapshot(
  identity: Pick<IngestIdentity, 'id' | 'code' | 'isGateway'>,
  certificateVerified: boolean,
  ts: Date = new Date(),
): Promise<AttributeFrame[]> {
  const isOffset = await offsetKeyTest();
  const setOf = (rows: { key: string; value: string }[]) =>
    Object.fromEntries(rows.filter((r) => !isOffset(r.key)).map((r) => [r.key, r.value]));
  const own = await prisma.instrumentAttribute.findMany({ where: { instrumentId: identity.id }, select: { key: true, value: true } });
  const frames: AttributeFrame[] = [{ device: identity.code, attributes: setOf(own), changed: {}, ts: ts.toISOString() }];
  if (!identity.isGateway) return frames;
  const children = await prisma.instrument.findMany({
    where: { gatewayId: identity.id },
    select: { code: true, profile: { select: { requireDeviceCertificate: true } }, attributes: { select: { key: true, value: true } } },
    orderBy: { code: 'asc' },
  });
  for (const c of children) {
    if (c.profile.requireDeviceCertificate && !certificateVerified) continue;
    frames.push({ device: c.code, attributes: setOf(c.attributes), changed: {}, ts: ts.toISOString() });
  }
  return frames;
}

/** What a subscriber re-checks before every write — `null` = the connection may no longer receive. */
export type SubscriberCheck = () => Promise<{ identity: IngestIdentity; certificateVerified: boolean } | null>;

/**
 * One connection's attribute subscription (WS and TCP share it).
 *
 * - REGISTER, then send the snapshot: the other order loses a change that lands
 *   in between; a duplicate is harmless, the frame is idempotent state.
 * - Every write is SERIALISED: two quick changes must reach the device in
 *   commit order, or it ends holding the older complete set.
 * - Every write first runs `check` (re-authorisation + the certificate rule),
 *   so a token revoked, or an instrument deactivated or deleted, stops the
 *   pushes even on a connection that never sends another frame; the check
 *   closes the connection itself.
 * - A child's frame is written only while the child is still linked, and — if
 *   its profile requires a certificate — only on a verified connection.
 */
export function attributeSubscription(opts: {
  targetId: string;
  check: SubscriberCheck;
  write: (text: string) => void;
}): { subscribe(): void; close(): void } {
  let chain: Promise<void> = Promise.resolve();
  let unsubscribe: (() => void) | null = null;
  let closed = false;
  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(job).catch(() => { /* a failed write must not wedge the chain */ });
  };
  const writeFrame = (f: AttributeFrame) => { if (!closed) opts.write(JSON.stringify(f)); };

  return {
    subscribe() {
      if (closed) return;
      if (!unsubscribe) {
        unsubscribe = subscribeAttributes(opts.targetId, (frame, instrumentId) => {
          enqueue(async () => {
            const ok = await opts.check();
            if (!ok || closed) return;
            if (instrumentId !== opts.targetId) {
              const child = [...(await childMapFor(opts.targetId)).values()].find((c) => c.id === instrumentId);
              if (!child) return;
              if (child.requiresCertificate && !ok.certificateVerified) return;
            }
            writeFrame(frame);
          });
        });
      }
      enqueue(async () => {
        const ok = await opts.check();
        if (!ok || closed) return;
        for (const f of await attributeSnapshot(ok.identity, ok.certificateVerified)) writeFrame(f);
      });
    },
    close() {
      closed = true;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
