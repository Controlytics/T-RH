import { randomUUID } from 'node:crypto';
import { parsePayload, toReadings } from './payload-parser.js';
import { writeBatch, writeDeadLetters } from './telemetry.repository.js';
import { stampLastSeen } from './last-seen.js';
import { enqueueAlarmEvaluation } from '../alarms/enqueue-evaluation.js';
import { fanoutDevices } from './gateway-fanout.js';
import { childMapFor } from './gateway-children.js';
import type { IngestIdentity } from './ingest-auth.js';
import { logger } from '../../lib/logger.js';

/**
 * Transport-agnostic ingest core.
 *
 * A listener's whole job is to obtain bytes and obtain a token; everything that
 * happens after — parse, gateway fan-out or flat, dead-lettering, the batched
 * write, last-seen stamping — happens exactly once, here. Five listeners
 * re-deriving the gateway authorisation rule is how a fix in one place silently
 * misses four.
 *
 * NOT owned here: the body/frame SIZE CAP. It cannot be, because on HTTP it is a
 * Fastify `bodyLimit` enforced during body parsing (i.e. before the token is even
 * checked). Every other listener must enforce its own equivalent BEFORE calling
 * in — see the `BODY_LIMIT_BYTES` comment in `ingest-routes.ts` for the
 * arithmetic that ties 64 KB to Postgres's bind-parameter ceiling on the BATCH
 * path. That cap is load-bearing, not a formality.
 */

// Applies to the FLAT path. `writeBatch` builds one multi-row INSERT for the
// whole array. Postgres caps bind parameters (65535) per statement; each row
// binds 5 params, so an unbounded key count could blow that ceiling and surface
// as an uncaught 500 from an otherwise-authenticated caller. 1000 keys is far
// beyond any real sensor payload. (The batch path is bounded by the listener's
// body/frame size cap instead — see the note above it.)
const MAX_KEYS = 1000;

// Dead-letter rows written for ONE rejected batch, before they collapse into a
// single summary row. See the write site for why an uncapped one-row-per-code
// is an amplifier.
const MAX_DEAD_LETTERS_PER_BATCH = 20;

// `rejected` is ABSENT (not 0) on the flat path. The flat path has no notion of
// rejection — every key that survived the cap is written — and its HTTP body has
// never carried the key. Normalising it to 0 would change a response shape an
// integrator is already parsing. A listener that just wants a number uses
// `rejected ?? 0` and never has to know which shape it got.
export type IngestOutcome =
  | { ok: true; accepted: number; rejected?: number }
  | { ok: false; code: 'UNPARSEABLE' | 'NOT_A_GATEWAY' | 'TOO_MANY_KEYS'; message: string };

interface DeadLetterRow {
  id: string;
  instrumentId: string;
  transport: string;
  reason: string;
  rawPayload: string | null;
}

/**
 * Dead-lettering is a record ABOUT a failure; it must never itself become the
 * failure. An unguarded throw here would turn a recorded-and-handled bad block
 * into a 500 and — on the batch path, where dead-letters are written before
 * `writeBatch` — would discard the readings that were perfectly good.
 */
async function safeWriteDeadLetters(rows: DeadLetterRow[]): Promise<void> {
  try {
    await writeDeadLetters(rows);
  } catch (e) {
    logger.error('[ingest] dead-letter write failed', e);
  }
}

export async function ingestPayload(args: {
  identity: IngestIdentity;
  raw: Buffer;
  /** The transport it actually ARRIVED on. Recorded verbatim on dead-letters. */
  transport: string;
}): Promise<IngestOutcome> {
  const { identity, raw, transport } = args;

  const parsed = parsePayload(raw);
  if (!parsed.ok) {
    // Never 500 on a malformed device payload — record it and move on, so one
    // bad device cannot take the endpoint down for the others. The caller maps
    // this to 202 (not 400) because this shape genuinely can't be parsed —
    // there is nothing more a naive retry would fix, and we don't want a broken
    // device retry-storming.
    await safeWriteDeadLetters([{
      id: randomUUID(), instrumentId: identity.id, transport,
      reason: parsed.reason ?? 'Unknown parse failure', rawPayload: raw.toString('utf8').slice(0, 4000),
    }]);
    return { ok: false, code: 'UNPARSEABLE', message: parsed.reason ?? 'Unknown parse failure' };
  }

  const ts = parsed.ts ?? new Date();
  // Flat payload -> one instrument (the authenticated caller). Batch payload
  // (`{"devices": {...}}`) is device-keyed data for OTHER instruments. Only a
  // gateway may send one, and only for the instruments linked to it.
  if (parsed.devices) {
    if (!identity.isGateway) {
      await safeWriteDeadLetters([{
        id: randomUUID(), instrumentId: identity.id, transport,
        reason: 'Batch (devices) payload from an instrument that is not configured as a gateway',
        rawPayload: raw.toString('utf8').slice(0, 4000),
      }]);
      return {
        ok: false,
        code: 'NOT_A_GATEWAY',
        message: `Instrument "${identity.code}" is not configured as a gateway, so it cannot report for other instruments. Enable "Is Gateway" on it and link the instruments it reports for.`,
      };
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
      const rows: DeadLetterRow[] = rejected.slice(0, MAX_DEAD_LETTERS_PER_BATCH).map((r, i) => ({
        id: randomUUID(), instrumentId: identity.id, transport,
        reason: r.reason, rawPayload: i === 0 ? payload : null,
      }));
      if (rejected.length > MAX_DEAD_LETTERS_PER_BATCH) {
        // Not "the first 20 above": all rows are written in one call with
        // effectively identical receivedAt and the list is read desc, so
        // positional language would be wrong in the UI.
        rows.push({
          id: randomUUID(), instrumentId: identity.id, transport,
          reason: `Batch from gateway "${identity.code}" had ${rejected.length} rejected blocks; only the first ${MAX_DEAD_LETTERS_PER_BATCH} were recorded individually.`,
          rawPayload: null,
        });
      }
      await safeWriteDeadLetters(rows);
    }

    if (readings.length > 0) {
      await writeBatch(readings);
      await stampLastSeen([...new Set(readings.map((r) => r.instrumentId))], 'gateway');
      // Readings landed, so judge them now rather than at the next minute tick.
      // ENQUEUES, never evaluates: the evaluator must stay out of this path, or a
      // broken evaluation could reject a telemetry write. Never throws.
      await enqueueAlarmEvaluation();
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

    // ok, not a partial-failure code: the request was handled correctly and
    // every accepted reading is stored. `rejected` tells an integrator about
    // partial failure without making them read the dead-letter table.
    return { ok: true, accepted: readings.length, rejected: rejected.length };
  }

  const keyCount = Object.keys(parsed.values).length;
  if (keyCount > MAX_KEYS) {
    await safeWriteDeadLetters([{
      id: randomUUID(), instrumentId: identity.id, transport,
      reason: `Payload has ${keyCount} keys, exceeding the ${MAX_KEYS}-key limit`,
      rawPayload: raw.toString('utf8').slice(0, 4000),
    }]);
    return {
      ok: false,
      code: 'TOO_MANY_KEYS',
      message: `Payload has ${keyCount} keys; the limit is ${MAX_KEYS}.`,
    };
  }

  const readings = toReadings(parsed.values, ts);
  await writeBatch(readings.map((r) => ({ ...r, instrumentId: identity.id })));
  // "Is it talking?" is answered by the INSTRUMENT's own column, not by the
  // credential's lastUsedAt (spec D9) — a gateway-reported child never
  // presents a credential of its own. Throttled and never allowed to fail an
  // accepted reading.
  await stampLastSeen([identity.id], 'direct');
  // Same as the gateway path above: enqueue an evaluation so an excursion is raised
  // (or cleared) within seconds of the reading rather than on the next minute tick.
  await enqueueAlarmEvaluation();
  return { ok: true, accepted: readings.length };
}
