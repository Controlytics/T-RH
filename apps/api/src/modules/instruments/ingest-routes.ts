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
//
// RAISING THIS IS NOT FREE — it is what bounds the BATCH path's reading count.
// `MAX_KEYS` below is applied to the flat path only; on the batch path the body
// limit is the only thing standing between a device and `writeBatch`'s bind
// ceiling. The arithmetic, derived from `telemetry.repository.ts`: the history
// INSERT binds 5 params per reading (instrument_id, key, value, value_type, ts)
// against Postgres's 65535-per-statement cap, i.e. 13_107 readings. The
// smallest a reading can be inside a device block is `"k":1,` = 6 bytes, so
// 65_536 bytes buys at most ~10_922 — under the ceiling, with no margin anyone
// wrote down. Raise this past ~78 KB and a single authenticated gateway can
// blow the bind cap and get an uncaught 500. Either cap the batch path's total
// reading count at the same time, or don't raise it.
const BODY_LIMIT_BYTES = 65_536;

// Applies to the FLAT path. `writeBatch` builds one multi-row INSERT for the
// whole array. Postgres caps bind parameters (65535) per statement; each row
// binds 5 params, so an unbounded key count could blow that ceiling and surface
// as an uncaught 500 from an otherwise-authenticated caller. 1000 keys is far
// beyond any real sensor payload. (The batch path is bounded by
// BODY_LIMIT_BYTES instead — see the note above it.)
const MAX_KEYS = 1000;

// Dead-letter rows written for ONE rejected batch, before they collapse into a
// single summary row. See the write site for why an uncapped one-row-per-code
// is an amplifier.
const MAX_DEAD_LETTERS_PER_BATCH = 20;

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
        //
        // CAPPED, unlike the flat path (which writes exactly one row per
        // request). One row per rejected code, each carrying its own copy of
        // the raw payload, is an amplifier: a misconfigured gateway posting a
        // 64 KB body of ~1000 unknown codes writes ~1000 rows x 4 KB ~= 4 MB
        // per request, and at 600 req/min that is GB/minute of dead_letters
        // growth from one valid token. `GET /:id/dead-letters` caps at 200, so
        // the operator cannot even see the flood it caused.
        //
        // The payload is stored on the FIRST row only — every row carried an
        // identical copy, so the other 19 were pure duplication.
        const payload = raw.toString('utf8').slice(0, 4000);
        const rows = rejected.slice(0, MAX_DEAD_LETTERS_PER_BATCH).map((r, i) => ({
          id: randomUUID(), instrumentId: identity.id, transport: 'http',
          reason: r.reason, rawPayload: i === 0 ? payload : null,
        }));
        if (rejected.length > MAX_DEAD_LETTERS_PER_BATCH) {
          // Not "the first 20 above": all rows are written in one call with
          // effectively identical receivedAt and the list is read desc, so
          // positional language would be wrong in the UI.
          rows.push({
            id: randomUUID(), instrumentId: identity.id, transport: 'http',
            reason: `Batch from gateway "${identity.code}" had ${rejected.length} rejected blocks; only the first ${MAX_DEAD_LETTERS_PER_BATCH} were recorded individually.`,
            rawPayload: null,
          });
        }
        await writeDeadLetters(rows);
      }

      if (readings.length > 0) {
        await writeBatch(readings);
        await stampLastSeen([...new Set(readings.map((r) => r.instrumentId))], 'gateway');
      }

      // The GATEWAY itself connected and authenticated directly — that is
      // literally true of it even though the readings it carried belong to
      // its children, so it gets 'direct' (not 'gateway', which on a child
      // means "someone else reported for me"; reusing it here would make the
      // column mean two different things). Stamped unconditionally once we
      // reach this point, even if every block above was rejected: the
      // gateway authenticated and delivered a well-formed payload, so it is
      // demonstrably alive — its dead-letters are what shows the payload was
      // wrong, not its last-seen column.
      await stampLastSeen([identity.id], 'direct');

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
