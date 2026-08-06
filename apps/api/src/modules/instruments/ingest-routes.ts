import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolveInstrumentByToken } from './ingest-auth.js';
import { parsePayload, toReadings } from './payload-parser.js';
import { writeBatch, writeDeadLetters } from './telemetry.repository.js';
import { stampLastSeen } from './last-seen.js';
import { fanoutDevices } from './gateway-fanout.js';
import { childMapFor } from './gateway-children.js';

function bearer(header?: string): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : '';
}

// Telemetry JSON is small (a handful of key/value readings). 64 KB is
// generous headroom while keeping an unauthenticated caller from forcing a
// large JSON.parse + object-copy on every request — the global 10 MB limit
// (app.ts) is sized for authenticated uploads, not this route.
const BODY_LIMIT_BYTES = 65_536;

// `writeBatch` builds one multi-row INSERT for the whole array. Postgres caps
// bind parameters (65535) per statement; each row binds 5 params, so an
// unbounded key count could blow that ceiling and surface as an uncaught 500
// from an otherwise-authenticated caller. 1000 keys is far beyond any real
// sensor payload.
const MAX_KEYS = 1000;

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
      },
    },
  }, async (req, reply) => {
    const identity = await resolveInstrumentByToken(bearer(req.headers.authorization));
    if (!identity) return reply.code(401).send({ error: 'INVALID_DEVICE_TOKEN' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? ''));
    const parsed = parsePayload(raw);
    if (!parsed.ok) {
      // Never 500 on a malformed device payload — record it and move on, so one
      // bad device cannot take the endpoint down for the others. 202 (not 400)
      // because this shape genuinely can't be parsed — there is nothing more a
      // naive retry would fix, and we don't want a broken device retry-storming.
      await writeDeadLetters([{
        id: randomUUID(), instrumentId: identity.id, transport: 'http',
        reason: parsed.reason ?? 'Unknown parse failure', rawPayload: raw.toString('utf8').slice(0, 4000),
      }]);
      return reply.code(202).send({ accepted: 0 });
    }

    const ts = parsed.ts ?? new Date();
    // Flat payload -> one instrument (the authenticated caller). Batch payload
    // (`{"devices": {...}}`) is device-keyed data for OTHER instruments. Only a
    // gateway may send one, and only for the instruments linked to it.
    if (parsed.devices) {
      if (!identity.isGateway) {
        await writeDeadLetters([{
          id: randomUUID(), instrumentId: identity.id, transport: 'http',
          reason: 'Batch (devices) payload from an instrument that is not configured as a gateway',
          rawPayload: raw.toString('utf8').slice(0, 4000),
        }]);
        return reply.code(400).send({
          error: 'NOT_A_GATEWAY',
          message: `Instrument "${identity.code}" is not configured as a gateway, so it cannot report for other instruments. Enable "Is Gateway" on it and link the instruments it reports for.`,
        });
      }

      const childMap = await childMapFor(identity.id);
      const { readings, rejected } = fanoutDevices(parsed.devices, childMap, ts, identity.code);

      if (rejected.length > 0) {
        // Attributed to the GATEWAY: the named child either does not exist or
        // is not ours, so filing it against that child would be a claim we
        // cannot make.
        await writeDeadLetters(rejected.map((r) => ({
          id: randomUUID(), instrumentId: identity.id, transport: 'http',
          reason: r.reason, rawPayload: raw.toString('utf8').slice(0, 4000),
        })));
      }

      if (readings.length > 0) {
        await writeBatch(readings);
        await stampLastSeen([...new Set(readings.map((r) => r.instrumentId))], 'gateway');
      }

      // 200, not 207: the request was handled correctly and every accepted
      // reading is stored. `rejected` tells an integrator about partial
      // failure without making them read the dead-letter table.
      return reply.send({ accepted: readings.length, rejected: rejected.length });
    }

    const keyCount = Object.keys(parsed.values).length;
    if (keyCount > MAX_KEYS) {
      await writeDeadLetters([{
        id: randomUUID(), instrumentId: identity.id, transport: 'http',
        reason: `Payload has ${keyCount} keys, exceeding the ${MAX_KEYS}-key limit`,
        rawPayload: raw.toString('utf8').slice(0, 4000),
      }]);
      return reply.code(400).send({
        error: 'TOO_MANY_KEYS',
        message: `Payload has ${keyCount} keys; the limit is ${MAX_KEYS}.`,
      });
    }

    const readings = toReadings(parsed.values, ts);
    await writeBatch(readings.map((r) => ({ ...r, instrumentId: identity.id })));
    // "Is it talking?" is answered by the INSTRUMENT's own column, not by the
    // credential's lastUsedAt (spec D9) — a gateway-reported child never
    // presents a credential of its own. Throttled and never allowed to fail an
    // accepted reading.
    await stampLastSeen([identity.id], 'direct');
    return reply.send({ accepted: readings.length });
  });
}
