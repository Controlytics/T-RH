import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { resolveInstrumentByToken } from './ingest-auth.js';
import { parsePayload, toReadings } from './payload-parser.js';
import { writeBatch, writeDeadLetters } from './telemetry.repository.js';

function bearer(header?: string): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : '';
}

export default async function ingestRoutes(app: FastifyInstance) {
  app.post('/telemetry', {
    // Tighter than the global 5000/min: this is the only route a device (or
    // anyone) can reach without logging in.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    schema: {
      tags: ['Ingest'],
      summary: 'Submit telemetry (device token auth)',
      response: {
        200: { type: 'object', properties: { accepted: { type: 'integer' } } },
        202: { type: 'object', properties: { accepted: { type: 'integer' } } },
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
      // bad device cannot take the endpoint down for the others.
      await writeDeadLetters([{
        id: randomUUID(), instrumentId: identity.id, transport: 'http',
        reason: parsed.reason ?? 'Unknown parse failure', rawPayload: raw.toString('utf8').slice(0, 4000),
      }]);
      return reply.code(202).send({ accepted: 0 });
    }

    const ts = parsed.ts ?? new Date();
    // Flat payload -> one instrument (the authenticated caller). Batch payload
    // (`{"devices": {...}}`) is device-keyed data for OTHER instruments, which
    // P1's single-instrument-token model has no way to authenticate — treat it
    // as malformed for now rather than silently attributing it to the caller.
    if (parsed.devices) {
      await writeDeadLetters([{
        id: randomUUID(), instrumentId: identity.id, transport: 'http',
        reason: 'Batch (devices) payload not supported over token-authenticated HTTP ingest',
        rawPayload: raw.toString('utf8').slice(0, 4000),
      }]);
      return reply.code(202).send({ accepted: 0 });
    }

    const readings = toReadings(parsed.values, ts);
    await writeBatch(readings.map((r) => ({ ...r, instrumentId: identity.id })));
    return reply.send({ accepted: readings.length });
  });
}
