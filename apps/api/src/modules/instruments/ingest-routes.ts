import { type FastifyInstance } from 'fastify';
import { resolveInstrumentByToken } from './ingest-auth.js';
import { ingestPayload } from './ingest-core.js';

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
      },
    },
  }, async (req, reply) => {
    const identity = await resolveInstrumentByToken(bearer(req.headers.authorization));
    if (!identity) return reply.code(401).send({ error: 'INVALID_DEVICE_TOKEN' });

    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? ''));
    const outcome = await ingestPayload({ identity, raw, transport: 'http' });

    if (!outcome.ok) {
      // 202 for an unparseable payload: it was recorded as a dead-letter and
      // there is nothing a naive retry would fix, so do not invite a retry
      // storm from a broken device. The other refusals are the caller's to fix.
      if (outcome.code === 'UNPARSEABLE') return reply.code(202).send({ accepted: 0 });
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
}
