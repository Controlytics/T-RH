import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { resolveInstrumentByToken } from './ingest-auth.js';
import { ingestPayload } from './ingest-core.js';
import { ingestAttributeReport } from './attribute-report.js';
import { attributeSnapshot } from './device-attributes.js';
import {
  certificateVerified, issueIdFromTlsSocket, judgeConnection, recordCertificateRefusal, refusalReason,
} from './device-certificate.js';

function bearer(header?: string): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : '';
}

// Telemetry JSON is small (a handful of key/value readings). 64 KB is
// generous headroom while keeping an unauthenticated caller from forcing a
// large JSON.parse + object-copy on every request — the global 10 MB limit
// (app.ts) is sized for authenticated uploads, not this route.
//
// RAISING THIS IS NOT FREE — it is what bounds the BATCH path's reading count.
// `MAX_KEYS` (ingest-core.ts) is applied to the flat path only; on the batch
// path the body limit is the only thing standing between a device and
// `writeBatch`'s bind ceiling. The arithmetic, derived from
// `telemetry.repository.ts`: the history INSERT binds 5 params per reading
// (instrument_id, key, value, value_type, ts) against Postgres's
// 65535-per-statement cap, i.e. 13_107 readings. The smallest a reading can be
// inside a device block is `"k":1,` = 6 bytes, so 65_536 bytes buys at most
// ~10_922 — under the ceiling, with no margin anyone wrote down. Raise this
// past ~78 KB and a single authenticated gateway can blow the bind cap and get
// an uncaught 500. Either cap the batch path's total reading count at the same
// time, or don't raise it.
//
// EVERY OTHER LISTENER MUST ENFORCE ITS OWN EQUIVALENT, before parsing. This is
// a Fastify body-parsing option, so the core cannot own it for them.
const BODY_LIMIT_BYTES = 65_536;

export default async function ingestRoutes(app: FastifyInstance) {
  app.post('/telemetry', {
    // Tighter than the global 5000/min: this is the only route a device (or
    // anyone) can reach without logging in.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    // Enforced during body parsing, before the handler (and therefore before
    // the token check) ever runs — an unauthenticated caller cannot force a
    // large parse by omitting the token.
    bodyLimit: BODY_LIMIT_BYTES,
    schema: {
      tags: ['Ingest'],
      summary: 'Submit telemetry (device token auth)',
      response: {
        200: { type: 'object', properties: { accepted: { type: 'integer' }, rejected: { type: 'integer' } } },
        202: { type: 'object', properties: { accepted: { type: 'integer' } } },
        400: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        401: { type: 'object', properties: { error: { type: 'string' } } },
        // The instrument's profile requires a device certificate and this
        // connection did not present its current one.
        403: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        422: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
        503: { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const identity = await resolveInstrumentByToken(bearer(req.headers.authorization));
    if (!identity) return reply.code(401).send({ error: 'INVALID_DEVICE_TOKEN' });

    // Device certificates (2026-10-27): the certificate the TLS layer
    // AUTHORIZED against the device CA on this connection, if any. The
    // server requests one only when the device CA is configured
    // (lib/https-options.ts); without TLS there is none.
    const presented = issueIdFromTlsSocket(req.raw.socket);
    const verdict = judgeConnection(identity, presented);
    if (!verdict.ok) {
      await recordCertificateRefusal(identity.id, 'http', verdict.code);
      return reply.code(403).send({ error: verdict.code, message: refusalReason(verdict.code, 'http') });
    }

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? ''));
    const outcome = await ingestPayload({
      identity, raw, transport: 'http', certificateVerified: certificateVerified(identity, presented),
    });

    if (!outcome.ok) {
      // 202 for an unparseable payload: it was recorded as a dead-letter and
      // there is nothing a naive retry would fix, so do not invite a retry
      // storm from a broken device. The other refusals are the caller's to fix.
      if (outcome.code === 'UNPARSEABLE') return reply.code(202).send({ accepted: 0 });
      // 503 for a write the DATABASE refused (a missing partition, an outage):
      // the payload was fine, it is recorded as a dead letter, and a retry
      // after the fault is repaired is exactly what the device should do.
      if (outcome.code === 'WRITE_FAILED') return reply.code(503).send({ error: outcome.code, message: outcome.message });
      // 422, NOT 503 (audit 2026-10-12, finding 5): the reading is older than
      // the oldest partition, so no retry can ever store it — a 503 here had a
      // device resending it forever. Dead-lettered in the core.
      if (outcome.code === 'TIMESTAMP_OUT_OF_RANGE') return reply.code(422).send({ error: outcome.code, message: outcome.message });
      return reply.code(400).send({ error: outcome.code, message: outcome.message });
    }

    // 200, not 207: the request was handled correctly and every accepted
    // reading is stored. `rejected` tells an integrator about partial
    // failure without making them read the dead-letter table.
    //
    // The FLAT path has never carried the key (it cannot reject anything) and
    // the core signals that by omitting it. Do not "normalise" a 0 in — an
    // integrator is parsing this body.
    return outcome.rejected === undefined
      ? reply.send({ accepted: outcome.accepted })
      : reply.send({ accepted: outcome.accepted, rejected: outcome.rejected });
  });

  // ── ATTRIBUTES over HTTP / HTTPS (2026-10-28, operator: "add for all
  // protocals"). The MQTT report topic and retained slot, as two requests:
  // the same token, the same certificate rule, the same body as
  // `instruments/<code>/attributes/report`. HTTP cannot push, so a device sees
  // an app-side change when it next GETs. See `device-attributes.ts`.
  /** Token + certificate, exactly as `/telemetry` decides them. `null` = the reply is sent. */
  async function deviceFor(req: FastifyRequest, reply: FastifyReply) {
    const identity = await resolveInstrumentByToken(bearer(req.headers.authorization));
    if (!identity) { reply.code(401).send({ error: 'INVALID_DEVICE_TOKEN' }); return null; }
    const presented = issueIdFromTlsSocket(req.raw.socket);
    const verdict = judgeConnection(identity, presented);
    if (!verdict.ok) {
      await recordCertificateRefusal(identity.id, 'http', verdict.code);
      reply.code(403).send({ error: verdict.code, message: refusalReason(verdict.code, 'http') });
      return null;
    }
    return { identity, verified: certificateVerified(identity, presented) };
  }

  const attributeSetProps = {
    device: { type: 'string' },
    // `additionalProperties` DECLARED: an object schema without it serialises to `{}`.
    attributes: { type: 'object', additionalProperties: { type: 'string' } },
  } as const;
  const errorShape = { type: 'object', properties: { error: { type: 'string' }, message: { type: 'string' } } } as const;

  app.post('/attributes', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    bodyLimit: BODY_LIMIT_BYTES,
    schema: {
      tags: ['Ingest'],
      summary: 'Report attributes (device token auth)',
      description: 'The body of the MQTT `instruments/<code>/attributes/report` topic: a flat object of keys, or a gateway\'s `devices` list naming each child under `devN`. Only device-writable keys are stored; an unchanged value is not written or audited.',
      response: {
        200: { type: 'object', properties: { written: { type: 'integer' }, unchanged: { type: 'integer' }, refused: { type: 'integer' } } },
        202: { type: 'object', properties: { written: { type: 'integer' } } },
        400: errorShape, 401: { type: 'object', properties: { error: { type: 'string' } } }, 403: errorShape,
      },
    },
  }, async (req, reply) => {
    const device = await deviceFor(req, reply);
    if (!device) return;
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? ''));
    const outcome = await ingestAttributeReport({ identity: device.identity, raw, transport: 'http', certificateVerified: device.verified });
    if (!outcome.ok) {
      // As telemetry: unparseable is recorded and not worth a retry storm.
      if (outcome.code === 'UNPARSEABLE') return reply.code(202).send({ written: 0 });
      return reply.code(400).send({ error: outcome.code, message: outcome.message });
    }
    return { written: outcome.written, unchanged: outcome.unchanged, refused: outcome.refused };
  });

  app.get('/attributes', {
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: {
      tags: ['Ingest'],
      summary: 'Read this device\'s attributes (device token auth)',
      description: 'What the MQTT retained slot carries: the complete set, sensor offsets left out; for a gateway, each linked child under its code.',
      response: {
        200: {
          type: 'object',
          properties: {
            ...attributeSetProps,
            ts: { type: 'string' },
            children: { type: 'array', items: { type: 'object', properties: attributeSetProps } },
          },
        },
        401: { type: 'object', properties: { error: { type: 'string' } } }, 403: errorShape,
      },
    },
  }, async (req, reply) => {
    const device = await deviceFor(req, reply);
    if (!device) return;
    const [own, ...children] = await attributeSnapshot(device.identity, device.verified);
    return {
      device: own.device, attributes: own.attributes, ts: own.ts,
      children: children.map((c) => ({ device: c.device, attributes: c.attributes })),
    };
  });
}
